import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { git } from "../git/git.js";

const exec = promisify(execFile);
export type Tool = (input: Record<string, unknown>) => Promise<unknown>;
export type ToolRegistry = Readonly<Record<string, Tool>>;

const forbiddenCommand = /(?:^|[\s;&|])(?:git\s+(?:commit|push)|rm\s+-rf|sudo|shutdown|format|del\s+\/[sq]|powershell|cmd)(?:\s|$)/i;
const allowedCommands = new Set(["npm", "npx", "pnpm", "yarn", "node", "go", "python", "python3", "pytest", "cargo"]);

async function scoped(root: string, candidate: unknown, allowMissing = false): Promise<string> {
  if (typeof candidate !== "string") throw new Error("path must be a string");
  const target = path.resolve(root, candidate);
  const realRoot = await fs.realpath(root);
  let checked: string;
  try { checked = await fs.realpath(target); }
  catch {
    if (!allowMissing) throw new Error("path does not exist");
    checked = path.resolve(await fs.realpath(path.dirname(target)), path.basename(target));
  }
  if (checked !== realRoot && !checked.startsWith(realRoot + path.sep)) throw new Error("path escapes project root");
  return checked;
}

export function createAgentTools(root: string): ToolRegistry {
  const readOnly: Record<string, Tool> = {
    listFiles: async () => ((await fs.readdir(root, { recursive: true }).catch(() => [])) ?? [])
      .map(String)
      .filter(file => !file.split(/[\\/]/).some(part => ["node_modules", ".git", "dist", "build", "coverage", ".next"].includes(part)))
      .slice(0, 200),
    readFile: async i => {
      const text = await fs.readFile(await scoped(root, i.path), "utf8");
      return text.length > 8_000 ? `${text.slice(0, 8_000)}\n\n[truncated ${text.length - 8_000} chars]` : text;
    },
    searchCode: async i => {
      const needle = String(i.query ?? "");
      if (!needle) return [];
      const files = ((await fs.readdir(root, { recursive: true }).catch(() => [])) ?? []).map(String).filter(x => !x.includes("node_modules") && !x.includes(".git"));
      const matches: string[] = [];
      for (const file of files.slice(0, 400)) {
        if (matches.length >= 20) break;
        try { if ((await fs.readFile(path.join(root, file), "utf8")).includes(needle)) matches.push(file); } catch { /* skip */ }
      }
      return matches;
    },
    readPackageJson: async () => JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
    readGitHistory: async () => git(root, ["log", "--oneline", "-20"]),
    getCurrentBranch: async () => git(root, ["branch", "--show-current"]),
    getGitStatus: async () => git(root, ["status", "--short"]),
    getGitDiff: async () => git(root, ["diff", "--stat"]),
    gitStatus: async () => git(root, ["status", "--short"]),
    gitDiff: async () => git(root, ["diff", "--stat"])
  };
  const dev: Record<string, Tool> = {
    writeFile: async i => {
      await fs.writeFile(await scoped(root, i.path, true), String(i.content ?? ""));
      return { ok: true, path: i.path };
    },
    editFile: async i => {
      const file = await scoped(root, i.path);
      const old = String(i.old ?? ""), content = await fs.readFile(file, "utf8");
      if (!content.includes(old)) throw new Error("edit target not found");
      await fs.writeFile(file, content.replace(old, String(i.replacement ?? "")));
      return { ok: true, path: i.path };
    },
    createFile: async i => {
      const file = await scoped(root, i.path, true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(i.content ?? ""), { flag: "wx" });
      return { ok: true, path: i.path };
    },
    deleteFile: async i => {
      await fs.unlink(await scoped(root, i.path));
      return { ok: true, path: i.path };
    },
    runTests: async () => run(root, ["npm", "test", "--", "--run"]),
    runLint: async () => run(root, ["npm", "run", "lint", "--if-present"]),
    runBuild: async () => run(root, ["npm", "run", "build", "--if-present"]),
    runCommand: async i => run(root, Array.isArray(i.argv) ? i.argv.map(String) : []),
    createBranch: async i => git(root, ["switch", "-c", String(i.name)])
  };
  return Object.freeze({ ...readOnly, ...dev });
}

async function run(root: string, argv: string[]) {
  if (!argv.length || !allowedCommands.has(argv[0]!) || forbiddenCommand.test(argv.join(" "))) throw new Error("command denied");
  const bin = argv[0] === "npm" && process.platform === "win32" ? "npm.cmd" : argv[0]!;
  const { stdout, stderr } = await exec(bin, argv.slice(1), {
    cwd: root,
    timeout: 120_000,
    windowsHide: process.platform !== "win32",
    shell: process.platform === "win32",
    maxBuffer: 5_000_000
  });
  return `${stdout}${stderr}`.slice(-4_000);
}

export const AGENT_FORBIDDEN_TOOLS = Object.freeze(["gitCommit", "gitPush"] as const);
