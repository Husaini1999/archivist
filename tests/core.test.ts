import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findGitRoot, PrivilegedGitService } from "../src/git/git.js";
import { createAgentTools, AGENT_FORBIDDEN_TOOLS } from "../src/tools/registry.js";
import { MemoryService } from "../src/memory/memory.js";
import { dateKey } from "../src/orchestrator/archivist.js";
import { detectTechnology } from "../src/discovery/projects.js";
import { parseProjectCommand } from "../src/telegram/bot.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { MockLLMProvider } from "../src/integrations/llm.js";

const run = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archivist-test-"));
  await run("git", ["init", root]);
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"echo ok"}}');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("git root and discovery", () => {
  it("walks upward to a git root", async () => {
    const nested = path.join(root, "a", "b"); await fs.mkdir(nested, { recursive: true });
    expect(await findGitRoot(nested)).toBe(await fs.realpath(root));
  });
  it("detects technology and rejects ordinary directories", async () => {
    expect(await detectTechnology(root)).toBe("node");
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "plain-"));
    expect(await findGitRoot(plain)).toBeNull();
    await fs.rm(plain, { recursive: true });
  });
});

describe("programmatic agent safety", () => {
  it("physically omits commit and push", () => {
    const tools = createAgentTools(root);
    expect(Object.keys(tools)).not.toContain("gitCommit");
    expect(Object.keys(tools)).not.toContain("gitPush");
    expect(AGENT_FORBIDDEN_TOOLS).toEqual(["gitCommit", "gitPush"]);
  });
  it("denies commit through restricted command runner", async () => {
    await expect(createAgentTools(root).runCommand({ argv: ["git", "commit", "-m", "bad"] })).rejects.toThrow("denied");
  });
  it("blocks paths outside the repository", async () => {
    await expect(createAgentTools(root).readFile({ path: "../secret" })).rejects.toThrow(/escapes|does not exist/);
  });
  it("privileged git rejects invalid approval", async () => {
    const prisma = { approval: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(new PrivilegedGitService(prisma as never).commit("p", root, "bad", "message")).rejects.toThrow("approval required");
  });
});

describe("memory", () => {
  it("isolates projects, appends sections, and redacts secrets", async () => {
    const memory = new MemoryService(root);
    const file = await memory.appendHistory("Alpha", "2026-09-15", "Analysis", "api_key=supersecret");
    expect(file).toContain(path.join("alpha", "history"));
    expect(await fs.readFile(file, "utf8")).toContain("[REDACTED]");
    expect((await memory.ensure("Beta"))).not.toBe(memory.projectDir("Alpha"));
  });
});

describe("scheduler and telegram helpers", () => {
  it("produces timezone-aware daily keys", () => {
    expect(dateKey(new Date("2026-09-14T16:30:00Z"), "Asia/Kuala_Lumpur")).toBe("2026-09-15");
  });
  it("parses commands and project names", () => {
    expect(parseProjectCommand("/pause@ArchivistBot Pokemon Store")).toEqual({ command: "pause", project: "Pokemon Store" });
  });
});

describe("agent runtime", () => {
  it("executes allowed tools and validates output", async () => {
    const promptRoot = path.join(root, "prompts"); await fs.mkdir(promptRoot); await fs.writeFile(path.join(promptRoot, "qa.md"), "QA");
    const llm = new MockLLMProvider([
      { content: "", toolCall: { name: "ok", arguments: {} } },
      { content: '{"summary":"passed","completed":true,"findings":[]}' }
    ]);
    expect(await new AgentRuntime(llm, { ok: async () => "yes" }, promptRoot).run("qa", "test")).toMatchObject({ completed: true });
  });
  it("rejects a tool outside the role registry", async () => {
    const promptRoot = path.join(root, "prompts"); await fs.mkdir(promptRoot); await fs.writeFile(path.join(promptRoot, "qa.md"), "QA");
    const llm = new MockLLMProvider([{ content: "", toolCall: { name: "gitPush", arguments: {} } }]);
    await expect(new AgentRuntime(llm, {}, promptRoot).run("qa", "test")).rejects.toThrow("not allowed");
  });
});
