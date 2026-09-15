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
    listFiles: async () => (await fs.readdir(root, { recursive: true })).filter(x => !String(x).includes("node_modules")).slice(0, 5000),
    readFile: async i => fs.readFile(await scoped(root, i.path), "utf8"),
    searchCode: async i => {
      const needle = String(i.query ?? "");
      const files = (await fs.readdir(root, { recursive: true })).map(String).filter(x => !x.includes("node_modules"));
      const matches: string[] = [];
      for (const file of files.slice(0, 2000)) {
        try { if ((await fs.readFile(path.join(root, file), "utf8")).includes(needle)) matches.push(file); } catch {}
      }
      return matches;
    },
    readPackageJson: async () => JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
    readGitHistory: async () => git(root, ["log", "--oneline", "-20"]),
    getCurrentBranch: async () => git(root, ["branch", "--show-current"]),
    getGitStatus: async () => git(root, ["status", "--short"]),
    getGitDiff: async () => git(root, ["diff", "--stat"]),
    gitStatus: async () => git(root, ["status", "--short"]),
    gitDiff: async () => git(root, ["diff"])
  };
  const dev: Record<string, Tool> = {
    writeFile: async i => fs.writeFile(await scoped(root, i.path, true), String(i.content ?? "")),
    editFile: async i => {
      const file = await scoped(root, i.path);
      const old = String(i.old ?? ""), content = await fs.readFile(file, "utf8");
      if (!content.includes(old)) throw new Error("edit target not found");
      await fs.writeFile(file, content.replace(old, String(i.replacement ?? "")));
    },
    createFile: async i => {
      const file = await scoped(root, i.path, true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(i.content ?? ""), { flag: "wx" });
    },
    deleteFile: async i => fs.unlink(await scoped(root, i.path)),
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
  const { stdout, stderr } = await exec(argv[0]!, argv.slice(1), { cwd: root, timeout: 120_000, windowsHide: true, maxBuffer: 5_000_000 });
  return `${stdout}${stderr}`.slice(-50_000);
}

export const AGENT_FORBIDDEN_TOOLS = Object.freeze(["gitCommit", "gitPush"] as const);
