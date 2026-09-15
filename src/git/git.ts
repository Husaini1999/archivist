import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";

const exec = promisify(execFile);

export async function git(root: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], { timeout, windowsHide: true, maxBuffer: 10_000_000 });
  return stdout.trim();
}

export async function findGitRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  while (true) {
    try {
      if ((await fs.stat(path.join(current, ".git"))).isDirectory() || (await fs.readFile(path.join(current, ".git"), "utf8")).startsWith("gitdir:")) return await fs.realpath(current);
    } catch { /* walk upward */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function currentBranch(root: string): Promise<string> {
  return (await git(root, ["branch", "--show-current"])) || "HEAD";
}

export class PrivilegedGitService {
  constructor(private readonly prisma: PrismaClient) {}

  private async requireApproval(id: string, type: string, projectId: string) {
    const approval = await this.prisma.approval.findUnique({ where: { id } });
    if (!approval || approval.projectId !== projectId || approval.type !== type || approval.status !== "APPROVED" || approval.expiresAt <= new Date()) {
      throw new Error(`Valid approved ${type} approval required`);
    }
    return approval;
  }

  async commit(projectId: string, root: string, approvalId: string, message: string, type: "COMMIT" | "MEMORY_COMMIT" = "COMMIT") {
    await this.requireApproval(approvalId, type, projectId);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", message]);
    const hash = await git(root, ["rev-parse", "HEAD"]);
    await this.prisma.gitOperation.create({ data: { projectId, approvalId, type: type.toLowerCase().replace("_", "-"), status: "SUCCEEDED", commitHash: hash } });
    return hash;
  }

  async push(projectId: string, root: string, approvalId: string, remote = "origin") {
    await this.requireApproval(approvalId, "PUSH", projectId);
    await git(root, ["push", remote, "HEAD"]);
    await this.prisma.gitOperation.create({ data: { projectId, approvalId, type: "push", status: "SUCCEEDED" } });
  }

  async publish(projectId: string, root: string, approvalId: string, opts: { message: string; base: string; title: string; body: string }) {
    await this.requireApproval(approvalId, "COMMIT", projectId);
    await git(root, ["add", "-A"]);
    const pending = await git(root, ["status", "--porcelain"]);
    if (!pending) throw new Error("Nothing to commit on the AI branch.");
    await git(root, ["commit", "-m", opts.message]);
    const hash = await git(root, ["rev-parse", "HEAD"]);
    const branch = await git(root, ["branch", "--show-current"]);
    await git(root, ["push", "-u", "origin", "HEAD"]);
    let prUrl: string | undefined;
    try {
      const { createPullRequest, githubCompareUrl } = await import("./branch.js");
      try {
        prUrl = await createPullRequest(root, {
          base: opts.base,
          title: opts.title,
          body: `${opts.body}\n\nThis PR targets \`${opts.base}\`. Archivist does not merge it. ${opts.base} / production stay unchanged until a human merges on GitHub.`
        });
      } catch {
        const remote = await git(root, ["remote", "get-url", "origin"]).catch(() => "");
        prUrl = githubCompareUrl(remote, opts.base, branch);
      }
    } catch {
      /* PR helpers unavailable */
    }
    await this.prisma.gitOperation.create({ data: { projectId, approvalId, type: "publish", status: "SUCCEEDED", commitHash: hash } });
    return { hash, branch, prUrl };
  }
}
