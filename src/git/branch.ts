import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "./git.js";

const exec = promisify(execFile);

export function taskBranchName(projectSlug: string, taskId: string, title: string) {
  const slug = projectSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const kebab = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "task";
  return `ai/${slug}/${kebab}-${taskId.slice(-6)}`.slice(0, 70);
}

export function packBranchName(projectSlug: string, taskId: string, count: number) {
  const slug = projectSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const label = count > 1 ? `${count}-improvements` : "improvements";
  return `ai/${slug}/${label}-${taskId.slice(-6)}`.slice(0, 70);
}

export async function detectDefaultBranch(root: string): Promise<string> {
  const originHead = await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]).catch(() => "");
  const fromOrigin = originHead.replace(/^refs\/remotes\/origin\//, "").trim();
  if (fromOrigin && fromOrigin !== originHead) return fromOrigin;
  const listed = (await git(root, ["branch", "--list", "main", "master"]).catch(() => ""))
    .split("\n")
    .map(line => line.replace(/^\*?\s+/, "").trim())
    .filter(Boolean);
  if (listed.includes("main")) return "main";
  if (listed.includes("master")) return "master";
  return (await git(root, ["branch", "--show-current"]).catch(() => "")) || "main";
}

export async function startTaskBranch(root: string, branch: string, base: string) {
  const dirty = await git(root, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error(`Working tree is not clean. Archivist needs a clean checkout of ${base} before creating ${branch}.`);
  }
  await git(root, ["switch", base]).catch(async () => git(root, ["checkout", base]));
  await git(root, ["switch", "-C", branch, base]).catch(async () => git(root, ["checkout", "-B", branch, base]));
}

export async function discardTaskWork(root: string, base: string) {
  await git(root, ["reset", "--hard", "HEAD"]).catch(() => "");
  await git(root, ["clean", "-fd"]).catch(() => "");
  await git(root, ["switch", "-f", base]).catch(async () => git(root, ["checkout", "-f", base]));
}

export function parseGithubRepo(remote: string): { owner: string; repo: string } | null {
  const cleaned = remote.trim().replace(/\.git$/, "");
  const match = /github\.com[:/]([^/]+)\/([^/]+)$/i.exec(cleaned);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export function githubCompareUrl(remote: string, base: string, head: string) {
  const parsed = parseGithubRepo(remote);
  if (!parsed) return undefined;
  return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

export async function createPullRequest(root: string, opts: { base: string; title: string; body: string }) {
  try {
    const { stdout } = await exec("gh", ["pr", "create", "--base", opts.base, "--title", opts.title, "--body", opts.body], {
      cwd: root,
      timeout: 60_000,
      windowsHide: true
    });
    return stdout.trim().split(/\s+/).find(part => part.startsWith("http")) || stdout.trim();
  } catch (error) {
    const text = `${(error as { stdout?: string }).stdout ?? ""} ${(error as { stderr?: string }).stderr ?? ""} ${String(error)}`;
    if (/already exists/i.test(text)) {
      const { stdout } = await exec("gh", ["pr", "view", "--json", "url", "-q", ".url"], { cwd: root, timeout: 30_000, windowsHide: true });
      return stdout.trim();
    }
    throw error;
  }
}
