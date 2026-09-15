import fs from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "../cancel.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", "out", "vendor", ".cache"]);
const SOURCE = /\.(tsx?|jsx?|vue|svelte|md|css|scss)$/i;
const INTERESTING = /error|empty|loading|login|auth|form|checkout|payment|search|a11y|accessib|toast|modal|layout|nav|button|page|route|api/i;

function skipDir(name: string) {
  return SKIP.has(name) || name.startsWith(".");
}

async function walk(root: string, signal?: AbortSignal, limit = 120): Promise<string[]> {
  const found: string[] = [];
  const stack = [root];
  while (stack.length && found.length < limit) {
    throwIfAborted(signal);
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (found.length >= limit) break;
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (SOURCE.test(entry.name)) found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

async function readSnippet(file: string, max = 2500) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.slice(0, max);
  } catch {
    return "";
  }
}

export async function inspectRepository(root: string, signal?: AbortSignal): Promise<string> {
  const top = (await fs.readdir(root).catch(() => [])).filter(name => !skipDir(name) && name !== "package-lock.json");
  const pkg = await readSnippet(path.join(root, "package.json"), 2000);
  const readme = await readSnippet(path.join(root, "README.md"), 800);
  const files = await walk(root, signal, 80);
  const ranked = files
    .map(file => ({ file, score: INTERESTING.test(file) ? 2 : 1, rel: path.relative(root, file) }))
    .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  const samples = [];
  for (const item of ranked.slice(0, 5)) {
    throwIfAborted(signal);
    const snippet = await readSnippet(item.file, 1000);
    if (snippet) samples.push(`### ${item.rel}\n${snippet}`);
  }
  return [
    `Top-level: ${top.slice(0, 40).join(", ") || "(empty)"}`,
    pkg ? `package.json:\n${pkg}` : "No package.json",
    readme ? `README excerpt:\n${readme}` : "No README",
    `Sampled source files (${files.length} discovered, showing ${samples.length}):`,
    samples.join("\n\n") || "No source files sampled."
  ].join("\n\n");
}
