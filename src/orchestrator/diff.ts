import fs from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git.js";

export type FileChange = { file: string; added: number; deleted: number };

function normalize(file: string) {
  return file.replace(/\\/g, "/").replace(/^"|"$/g, "").trim();
}

function addFile(files: Map<string, FileChange>, file: string, added: number, deleted: number) {
  const key = normalize(file);
  if (!key || key.endsWith("/")) return;
  const previous = files.get(key);
  if (previous) {
    previous.added += added;
    previous.deleted += deleted;
    return;
  }
  files.set(key, { file: key, added, deleted });
}

function parseNumstat(text: string, files: Map<string, FileChange>) {
  for (const line of text.split("\n").filter(Boolean)) {
    const [addedRaw, deletedRaw, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file) continue;
    addFile(files, file, addedRaw === "-" ? 0 : Number(addedRaw) || 0, deletedRaw === "-" ? 0 : Number(deletedRaw) || 0);
  }
}

export async function collectDiff(root: string): Promise<{ files: FileChange[]; added: number; deleted: number; shortstat: string }> {
  const files = new Map<string, FileChange>();
  parseNumstat(await git(root, ["diff", "HEAD", "--numstat"]).catch(() => ""), files);
  parseNumstat(await git(root, ["diff", "--cached", "--numstat"]).catch(() => ""), files);
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"]).catch(() => "")).split("\n").map(normalize).filter(Boolean);
  for (const file of untracked) {
    if (files.has(file)) continue;
    let added = 1;
    try { added = (await fs.readFile(path.join(root, file), "utf8")).split(/\r?\n/).length; } catch { added = 1; }
    addFile(files, file, added, 0);
  }
  const list = [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
  const added = list.reduce((sum, item) => sum + item.added, 0);
  const deleted = list.reduce((sum, item) => sum + item.deleted, 0);
  const shortstat = await git(root, ["diff", "HEAD", "--shortstat"]).catch(() => "");
  return { files: list, added, deleted, shortstat: shortstat || `${list.length} files, +${added} −${deleted}` };
}

export async function filePatch(root: string, file: string): Promise<string> {
  const diff = await git(root, ["diff", "HEAD", "--", file]).catch(() => "");
  if (diff.trim()) return diff;
  try {
    const content = await fs.readFile(path.join(root, file), "utf8");
    return content.split(/\r?\n/).map(line => `+${line}`).join("\n");
  } catch {
    return "(file unavailable)";
  }
}
