import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { currentBranch, findGitRoot, git } from "../git/git.js";
import { safeSlug } from "../security/redact.js";

export async function detectTechnology(root: string): Promise<string> {
  const checks: [string, string][] = [["package.json", "node"], ["go.mod", "go"], ["pyproject.toml", "python"], ["Cargo.toml", "rust"]];
  const found: string[] = [];
  for (const [file, tech] of checks) try { await fs.access(path.join(root, file)); found.push(tech); } catch {}
  return found.join(",") || "unknown";
}

export async function registerProject(prisma: PrismaClient, candidate: string) {
  const root = await findGitRoot(candidate);
  if (!root) throw new Error(`${candidate} is not inside a Git repository`);
  const name = path.basename(root);
  const base = safeSlug(name);
  let slug = base, suffix = 2;
  while (await prisma.project.findFirst({ where: { slug, NOT: { gitRoot: root } } })) slug = `${base}-${suffix++}`;
  const branch = await currentBranch(root);
  const technology = await detectTechnology(root);
  const lastKnownCommit = await git(root, ["rev-parse", "HEAD"]).catch(() => null);
  return prisma.project.upsert({
    where: { gitRoot: root },
    create: { name, slug, gitRoot: root, branch, technology, lastKnownCommit },
    update: { branch, technology, lastKnownCommit }
  });
}

export async function scanProjects(prisma: PrismaClient, roots: string[], archivistHome: string, softwareRoot?: string) {
  const seen = new Set<string>(), projects = [];
  const skip = new Set<string>([
    await fs.realpath(archivistHome).catch(() => path.resolve(archivistHome))
  ]);
  if (softwareRoot) skip.add(await fs.realpath(softwareRoot).catch(() => path.resolve(softwareRoot)));
  for (const root of roots) {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.filter(x => x.isDirectory())) {
      const candidate = path.join(root, entry.name);
      const gitRoot = await findGitRoot(candidate);
      if (!gitRoot || skip.has(gitRoot) || seen.has(gitRoot)) continue;
      seen.add(gitRoot);
      projects.push(await registerProject(prisma, gitRoot));
    }
  }
  return projects;
}
