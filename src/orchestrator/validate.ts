import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { throwIfAborted } from "../cancel.js";

const exec = promisify(execFile);
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

export type CheckResult = { name: string; status: "passed" | "failed" | "skipped"; excerpt: string };

type Pkg = { dir: string; label: string; scripts: Record<string, string> };

export async function findWorkspaces(root: string): Promise<Pkg[]> {
  const found: Pkg[] = [];
  const candidates = [root];
  let entries: string[] = [];
  try { entries = await fs.readdir(root); } catch { return found; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    candidates.push(path.join(root, name));
  }
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (!Object.keys(scripts).length && dir !== root) continue;
      found.push({ dir, label: dir === root ? "root" : path.basename(dir), scripts });
    } catch { /* not a package */ }
  }
  return found;
}

function testCommand(script: string): { argv: string[]; env?: NodeJS.ProcessEnv } {
  if (/craco test|react-scripts test/.test(script)) {
    return { argv: ["npm", "test", "--", "--watchAll=false"], env: { CI: "true" } };
  }
  if (/vitest/.test(script)) return { argv: ["npm", "test", "--", "--run"] };
  return { argv: ["npm", "test"] };
}

export async function runProjectChecks(root: string, signal?: AbortSignal): Promise<{ checks: CheckResult[]; testsPassed: boolean; tested: boolean }> {
  const workspaces = await findWorkspaces(root);
  const checks: CheckResult[] = [];
  const withTests = workspaces.filter(pkg => pkg.scripts.test);
  if (!withTests.length) checks.push({ name: "Tests", status: "skipped", excerpt: "No npm test script in the repo or frontend/backend packages." });
  else {
    for (const pkg of withTests) {
      const command = testCommand(pkg.scripts.test);
      checks.push(await runCheck(pkg.dir, withTests.length > 1 || pkg.label !== "root" ? `Tests (${pkg.label})` : "Tests", command.argv, signal, command.env));
    }
  }
  const withLint = workspaces.filter(pkg => pkg.scripts.lint);
  if (!withLint.length) checks.push({ name: "Lint", status: "skipped", excerpt: "No npm lint script." });
  else {
    for (const pkg of withLint) {
      checks.push(await runCheck(pkg.dir, withLint.length > 1 || pkg.label !== "root" ? `Lint (${pkg.label})` : "Lint", ["npm", "run", "lint"], signal));
    }
  }
  const withType = workspaces.filter(pkg => pkg.scripts.typecheck || pkg.scripts.build);
  if (!withType.length) checks.push({ name: "Typecheck/Build", status: "skipped", excerpt: "No typecheck or build script." });
  else {
    for (const pkg of withType) {
      const kind = pkg.scripts.typecheck ? "Typecheck" : "Build";
      const argv = pkg.scripts.typecheck ? ["npm", "run", "typecheck"] : ["npm", "run", "build"];
      checks.push(await runCheck(pkg.dir, withType.length > 1 || pkg.label !== "root" ? `${kind} (${pkg.label})` : kind, argv, signal));
    }
  }
  const tested = checks.some(check => check.name.startsWith("Tests") && check.status !== "skipped");
  const testsPassed = !checks.some(check => check.name.startsWith("Tests") && check.status === "failed");
  return { checks, testsPassed, tested };
}

async function runCheck(cwd: string, name: string, argv: string[], signal?: AbortSignal, extraEnv?: NodeJS.ProcessEnv): Promise<CheckResult> {
  throwIfAborted(signal);
  try {
    const bin = argv[0] === "npm" ? npmBin : argv[0]!;
    const { stdout, stderr } = await exec(bin, argv.slice(1), {
      cwd,
      timeout: 180_000,
      windowsHide: process.platform !== "win32",
      shell: process.platform === "win32",
      maxBuffer: 2_000_000,
      signal,
      env: { ...process.env, ...extraEnv, CI: extraEnv?.CI ?? process.env.CI ?? "true" }
    });
    return { name, status: "passed", excerpt: `${stdout}${stderr}`.trim().slice(-400) || "passed" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { name, status: "failed", excerpt: `${err.stdout ?? ""}${err.stderr ?? err.message ?? String(error)}`.trim().slice(-400) };
  }
}
