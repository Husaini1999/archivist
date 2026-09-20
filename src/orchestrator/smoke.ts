import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { throwIfAborted } from "../cancel.js";
import { findWorkspaces, type CheckResult } from "./validate.js";

const exec = promisify(execFile);
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const NOISE = /Download the React DevTools|favicon\.ico|\[HMR\]|\[vite\]|webpack-dev-server|Failed to load resource: the server responded with a status of 4\d\d|ResizeObserver loop|DevTools failed to load/i;

export function isBrowserApp(scripts: Record<string, string>) {
  return /vite|react-scripts|craco|next|webpack|parcel|remix|astro|vue-cli|ng serve/i.test(`${scripts.dev ?? ""} ${scripts.start ?? ""} ${scripts.build ?? ""}`);
}

export function isRuntimeNoise(text: string) {
  return !text.trim() || NOISE.test(text);
}

export function guessRoutes(source: string, limit = 6) {
  const routes = new Set<string>(["/"]);
  for (const match of source.matchAll(/\bpath\s*=\s*["'`](\/[^"'`*]*)["'`]/g)) {
    const route = (match[1]!.split(":")[0] || "/").replace(/\/+$/, "") || "/";
    routes.add(route);
  }
  return [...routes].slice(0, limit);
}

export async function findDevApp(root: string) {
  const apps = (await findWorkspaces(root)).filter(pkg => isBrowserApp(pkg.scripts) && (pkg.scripts.dev || pkg.scripts.start));
  return apps.find(pkg => /^(frontend|web|client|app)$/i.test(pkg.label)) ?? apps.find(pkg => pkg.scripts.dev) ?? apps[0];
}

export function npmStartArgv(scripts: Record<string, string>, port: number) {
  const script = scripts.dev ? "dev" : "start";
  const body = scripts[script] ?? "";
  if (/vite/i.test(body)) return ["run", script, "--", "--host", "127.0.0.1", "--port", String(port)];
  if (/next/i.test(body)) return ["run", script, "--", "-H", "127.0.0.1", "-p", String(port)];
  return script === "dev" ? ["run", "dev"] : ["start"];
}

export async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(error => error || !port ? reject(error ?? new Error("No port")) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    last = await new Promise<string>(resolve => {
      const req = http.get(url, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(`${res.statusCode ?? 0}\n${Buffer.concat(chunks).toString("utf8").slice(0, 2000)}`));
      });
      req.on("error", error => resolve(error.message));
      req.setTimeout(3000, () => { req.destroy(); resolve("timeout"); });
    });
    if (/^2\d\d|^3\d\d/m.test(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error(`Dev server did not become ready at ${url}: ${last.slice(0, 180)}`);
}

async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  const channels = process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  for (const channel of channels) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try next */ }
  }
  try { return await chromium.launch({ headless: true }); } catch { return undefined; }
}

export async function collectPageErrors(urls: string[], signal?: AbortSignal) {
  const browser = await launchBrowser();
  if (!browser) return { skipped: true as const, errors: ["No Chrome or Edge found to load the app."] };
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (!isRuntimeNoise(text)) errors.push(text);
    });
    for (const url of urls) {
      throwIfAborted(signal);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(error => {
        errors.push(`Failed to open ${url}: ${error instanceof Error ? error.message : String(error)}`);
      });
      const body = await page.content().catch(() => "");
      if (/Failed to compile|Uncaught (?:Syntax|Reference)?Error|vite:error/i.test(body)) {
        errors.push(`Compile/runtime overlay on ${url}`);
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { skipped: false as const, errors: [...new Set(errors.map(item => item.trim()).filter(Boolean))] };
}

async function routeSource(root: string, dir: string, changed: string[]) {
  const candidates = [
    ...changed.filter(file => /\.(tsx?|jsx?)$/.test(file)).slice(0, 8).map(file => path.join(root, file)),
    path.join(dir, "src", "App.jsx"),
    path.join(dir, "src", "App.tsx"),
    path.join(dir, "src", "App.js"),
    path.join(dir, "src", "routes.tsx"),
    path.join(dir, "src", "main.tsx")
  ];
  const chunks: string[] = [];
  for (const file of candidates) {
    try { chunks.push(await fs.readFile(file, "utf8")); } catch { /* missing */ }
  }
  return chunks.join("\n");
}

async function stopProcess(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await exec("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => undefined);
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

export async function runRuntimeSmoke(root: string, changedFiles: string[] = [], signal?: AbortSignal): Promise<CheckResult> {
  const app = await findDevApp(root);
  if (!app) return { name: "Runtime", status: "skipped", excerpt: "No Vite/CRA/Next start script to boot in a browser." };
  throwIfAborted(signal);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const argv = npmStartArgv(app.scripts, port);
  const child = spawn(npmBin, argv, {
    cwd: app.dir,
    env: { ...process.env, PORT: String(port), BROWSER: "none", HOST: "127.0.0.1", CI: "true" },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "pipe"
  });
  const logs: string[] = [];
  child.stdout?.on("data", chunk => { logs.push(String(chunk)); });
  child.stderr?.on("data", chunk => { logs.push(String(chunk)); });
  try {
    await waitForHttp(origin, 90_000, signal);
    const routes = guessRoutes(await routeSource(root, app.dir, changedFiles));
    const result = await collectPageErrors(routes.map(route => origin + route), signal);
    if (result.skipped) return { name: "Runtime", status: "skipped", excerpt: result.errors[0] || "Browser unavailable." };
    if (result.errors.length) return { name: "Runtime", status: "failed", excerpt: result.errors.slice(0, 6).join("\n").slice(0, 800) };
    return { name: "Runtime", status: "passed", excerpt: `Loaded ${routes.join(", ")} with no console/page errors.` };
  } catch (error) {
    const detail = `${error instanceof Error ? error.message : String(error)}\n${logs.join("").slice(-400)}`.trim();
    return { name: "Runtime", status: "failed", excerpt: detail.slice(0, 800) };
  } finally {
    await stopProcess(child);
  }
}
