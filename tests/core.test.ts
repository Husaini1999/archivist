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
    expect(await createAgentTools(root).writeFile({ path: "note.txt", content: "hi" })).toEqual({ ok: true, path: "note.txt" });
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
    const listed = await memory.listHistory("Alpha");
    expect(listed[0]?.events.some(event => event.kind === "Analysis")).toBe(true);
  });
  it("compacts README dumps into problems, recs, and file changes", async () => {
    const { compactDayMarkdown, parseHistoryEvents } = await import("../src/memory/memory.js");
    const { formatProjectHistory } = await import("../src/telegram/format.js");
    const messy = `# 2026-09-15

## Analysis

Technology: node. Branch: main. Working tree: clean.

README excerpt:
# ATS Resume Builder
## 🌟 Features
- Smart Resume Builder

## Recommendation

Improve AI API Key Error Feedback

Add frontend UI message.

Evidence: AI route returns 501 when the key is missing.

## Recommendation

Enhance Resume Import Error Handling

## Implementation

{
  "branch": "ai/ats-resumebuilder/3-improvements-n67rc4",
  "base": "main",
  "files": [
    { "file": "frontend/src/components/ResumeImportModal.jsx", "added": 29, "deleted": 0 },
    { "file": "frontend/src/pages/ResumeBuilder.jsx", "added": 18, "deleted": 1 }
  ]
}
`;
    const compact = compactDayMarkdown("2026-09-15", messy);
    expect(compact).not.toContain("README excerpt");
    expect(compact).not.toContain("🌟 Features");
    expect(compact).toContain("## Problems");
    expect(compact).toContain("## Recommendations");
    expect(compact).toContain("## Changes");
    expect(compact).toContain("ResumeImportModal.jsx  +29 −0");
    const memory = new MemoryService(root);
    await memory.upsertDay("Alpha", "2026-09-15", { problems: ["Already noted"] });
    await memory.upsertDay("Alpha", "2026-09-15", { changes: ["frontend/src/pages/ResumeBuilder.jsx  +18 −1"] });
    const day = await memory.readDay("Alpha", "2026-09-15");
    expect(day).toContain("Already noted");
    expect(day).toContain("ResumeBuilder.jsx");
    expect(day.match(/## Problems/g)?.length).toBe(1);
    const events = parseHistoryEvents(messy);
    expect(events.map(event => event.title)).toEqual(["What changed", "Outcome", "Recommendations", "Problems"]);
    expect(events.find(event => event.title === "What changed")?.lines).toContain("frontend/src/components/ResumeImportModal.jsx  +29 −0");
    const html = formatProjectHistory("ats-resumebuilder", [{ date: "2026-09-15", events }]);
    expect(html).toContain("<b>15 Sep 2026</b>");
    expect(html).toContain("<b>What changed</b>");
    expect(html).not.toContain("🌟 Features");
  });
});

describe("scheduler and telegram helpers", () => {
  it("produces timezone-aware daily keys", () => {
    expect(dateKey(new Date("2026-09-14T16:30:00Z"), "Asia/Kuala_Lumpur")).toBe("2026-09-15");
  });
  it("parses commands and project names", () => {
    expect(parseProjectCommand("/pause@ArchivistBot Pokemon Store")).toEqual({ command: "pause", project: "Pokemon Store" });
  });
  it("parses project picker callbacks and builds buttons", async () => {
    const { parseProjectPicker, buildProjectPicker } = await import("../src/telegram/bot.js");
    expect(parseProjectPicker("p:now:abc")).toEqual({ action: "now", projectId: "abc" });
    const keyboard = buildProjectPicker([{ id: "1", slug: "portfolio" }, { id: "2", slug: "th-web" }], "now");
    expect(JSON.stringify(keyboard.inline_keyboard)).toContain("p:now:1");
    expect(JSON.stringify(keyboard.inline_keyboard)).toContain("portfolio");
  });
  it("formats recommendations as short HTML sections", async () => {
    const { formatProposalMessage, toBullets } = await import("../src/telegram/format.js");
    expect(toBullets("One long sentence. Another sentence. Third.")).toHaveLength(3);
    const html = formatProposalMessage("ATS_ResumeBuilder", {
      title: "Show AI loading errors",
      summary: "Tie the overlay to isAIOptimizing and show a retry message.",
      evidence: "ResumeBuilder.jsx tracks isAIOptimizing with no matching error UI.",
      expected: "Users see progress and can recover when AI export fails."
    });
    expect(html).toContain("<b>Problem</b>");
    expect(html).toContain("<b>Solution</b>");
    expect(html).toContain("<b>Expected</b>");
    expect(html).toContain("ATS_ResumeBuilder");
  });
  it("formats implementation reports with tests and +/-", async () => {
    const { formatImplementationReport, formatFileDiff } = await import("../src/telegram/format.js");
    const html = formatImplementationReport("ATS", {
      branch: "ai/ats/show-a-spinner-abc123",
      base: "main",
      summary: "Show a spinner",
      files: [{ file: "src/App.tsx", added: 4, deleted: 1 }],
      added: 4,
      deleted: 1,
      checks: [{ name: "Tests", status: "passed" }],
      testsPassed: true,
      tested: true
    });
    expect(html).toContain("+4");
    expect(html).toContain("ai/ats/show-a-spinner-abc123");
    expect(html).toContain("✅");
    expect(formatImplementationReport("ATS", {
      branch: "x",
      base: "main",
      checks: [{ name: "Lint", status: "skipped", excerpt: "No npm lint script." }]
    })).toContain("skipped (No npm lint script)");
    expect(html).toContain("WARNING");
    expect(formatFileDiff("src/App.tsx", 1, 0, "+hello")).toContain("+hello");
  });
  it("numbers multiple recommendations", async () => {
    const { parseProposalList } = await import("../src/orchestrator/proposal.js");
    const { formatProposalList } = await import("../src/telegram/format.js");
    const parsed = parseProposalList(JSON.stringify({
      recommendations: [
        { title: "Fix loading", summary: "Show a spinner", evidence: "Page.jsx", expected: "Clearer wait state" },
        { title: "Fix errors", summary: "Show retry", evidence: "api.js", expected: "Recoverable failures" }
      ]
    }));
    expect(parsed).toHaveLength(2);
    const html = formatProposalList("ATS_ResumeBuilder", parsed.map(item => ({ title: item.title, summary: item.summary, evidence: item.evidence, expected: item.expected })));
    expect(html).toContain("1. Fix loading");
    expect(html).toContain("2. Fix errors");
    expect(html).toContain("Status: ⏳ waiting");
    expect(html).toContain("Nothing starts until Apply");
    const decided = formatProposalList("ATS_ResumeBuilder", parsed.map(item => ({ title: item.title, summary: item.summary, evidence: item.evidence, expected: item.expected })), ["accepted", "declined"]);
    expect(decided).toContain("Status: ✅ accept");
    expect(decided).toContain("Status: ❌ decline");
    expect(decided).toContain("Tap Apply");
  });
  it("gates Apply until every numbered rec is accepted or declined", async () => {
    const { allDecided, buildPackKeyboard, parsePackCallback, setPackDecision } = await import("../src/telegram/pack.js");
    const pack = {
      id: "pack12abcxyz",
      projectName: "ATS",
      items: [
        { proposal: { id: "p1", title: "A", summary: "", evidence: "", expected: "" }, token: "t1", decision: "pending" as const },
        { proposal: { id: "p2", title: "B", summary: "", evidence: "", expected: "" }, token: "t2", decision: "pending" as const }
      ]
    };
    expect(parsePackCallback("s:pack12abcxyz:0")).toEqual({ kind: "accept", packId: "pack12abcxyz", index: 0 });
    expect(parsePackCallback("r:pack12abcxyz:1")).toEqual({ kind: "decline", packId: "pack12abcxyz", index: 1 });
    expect(parsePackCallback("g:pack12abcxyz")).toEqual({ kind: "apply", packId: "pack12abcxyz" });
    expect(allDecided(pack)).toBe(false);
    expect(JSON.stringify(buildPackKeyboard(pack).inline_keyboard)).not.toContain("g:pack12abcxyz");
    setPackDecision(pack, 0, "accepted");
    expect(allDecided(pack)).toBe(false);
    setPackDecision(pack, 1, "declined");
    expect(allDecided(pack)).toBe(true);
    const ready = JSON.stringify(buildPackKeyboard(pack).inline_keyboard);
    expect(ready).toContain("g:pack12abcxyz");
    expect(ready).toContain("▶️ Apply");
    expect(ready).not.toContain("a:t1");
    expect(ready).not.toContain("🔍");
    expect(ready).not.toContain("i:p1");
  });
  it("coerces nested proposal JSON into strings", async () => {
    const { parseProposalOutput } = await import("../src/orchestrator/proposal.js");
    const parsed = parseProposalOutput(JSON.stringify({
      title: "Improve checkout errors",
      summary: "Users see a generic failure.",
      evidence: { files: ["Checkout.jsx"], count: 2 },
      expected: ["Clearer errors", "Retry"]
    }));
    expect(parsed.evidence).toContain("Checkout.jsx");
    expect(parsed.expected).toContain("Retry");
  });
  it("can abort in-flight work", async () => {
    const { throwIfAborted, isCancelled } = await import("../src/cancel.js");
    const { cancelKeyboard } = await import("../src/telegram/bot.js");
    const abort = new AbortController();
    abort.abort();
    expect(() => throwIfAborted(abort.signal)).toThrow(/Cancelled/);
    expect(isCancelled(Object.assign(new Error("Cancelled"), { name: "AbortError" }))).toBe(true);
    expect(JSON.stringify(cancelKeyboard("abc").inline_keyboard)).toContain("x:abc");
  });
  it("exposes the slash-command menu", async () => {
    const { BOT_COMMANDS } = await import("../src/telegram/bot.js");
    expect(BOT_COMMANDS.map(c => c.command)).toEqual(["start", "projects", "status", "enable", "disable", "now", "history", "pause", "resume", "cancel"]);
  });
});

describe("software root detection", () => {
  it("walks up from nested folders to package.json name archivist", async () => {
    const { findSoftwareRoot } = await import("../src/config/index.js");
    const nested = path.join(root, "src", "config");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "archivist" }));
    expect(findSoftwareRoot(nested)).toBe(path.resolve(root));
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
  it("wraps up instead of throwing when the tool-call budget is hit", async () => {
    const { iterationBudget } = await import("../src/agents/runtime.js");
    expect(iterationBudget(3)).toBeGreaterThanOrEqual(24);
    const promptRoot = path.join(root, "prompts"); await fs.mkdir(promptRoot); await fs.writeFile(path.join(promptRoot, "qa.md"), "QA");
    const llm = new MockLLMProvider([
      { content: "", toolCall: { name: "ok", arguments: {} } },
      { content: "", toolCall: { name: "ok", arguments: {} } },
      { content: '{"summary":"done","completed":true,"findings":[]}' }
    ]);
    expect(await new AgentRuntime(llm, { ok: async () => "yes" }, promptRoot, 2).run("qa", "test")).toMatchObject({ completed: true, summary: "done" });
  });
});

describe("llm request shaping", () => {
  it("omits empty tools and includes valid parameters when tools exist", async () => {
    const { buildChatBody, formatLlmHttpError } = await import("../src/integrations/llm.js");
    const empty = buildChatBody("gpt-4.1-mini", [{ role: "user", content: "hi" }], []);
    expect(empty.tools).toBeUndefined();
    const withTools = buildChatBody("gpt-4.1-mini", [{ role: "user", content: "hi" }], [{ name: "readFile", description: "Read", inputSchema: { type: "object" } }]);
    expect(JSON.stringify(withTools.tools)).toContain('"properties":{}');
    expect(formatLlmHttpError(400, JSON.stringify({ error: { message: "invalid tool schema" } }))).toContain("invalid tool schema");
    const { toApiMessage } = await import("../src/integrations/llm.js");
    const toolTurn = toApiMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_0", type: "function", function: { name: "readFile", arguments: "{}" } }]
    });
    expect(toolTurn.content).toBe("");
    expect(toolTurn.content).not.toBeNull();
  });
  it("parses OpenAI retry-after and stays under a TPM budget", async () => {
    const { parseRetryAfterSeconds, TokenBudget } = await import("../src/integrations/rateLimit.js");
    expect(parseRetryAfterSeconds("Please try again in 4.305s.")).toBe(5);
    let now = 0;
    let slept = 0;
    const budget = new TokenBudget(1000, 1, {
      now: () => now,
      sleep: async ms => { now += ms; slept = ms; }
    });
    budget.record(900);
    await budget.waitFor(200);
    expect(slept).toBeGreaterThan(0);
  });
  it("compacts old tool payloads", async () => {
    const { compactMessages, truncateToolOutput } = await import("../src/agents/runtime.js");
    expect(truncateToolOutput("a".repeat(50), 10)).toContain("truncated");
    expect(truncateToolOutput(undefined)).toBe("ok");
    expect(truncateToolOutput(null)).toBe("ok");
    const compacted = compactMessages([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "tool", tool_call_id: "1", content: "old-output" },
      { role: "tool", tool_call_id: "2", content: "kept-1" },
      { role: "tool", tool_call_id: "3", content: "kept-2" },
      { role: "tool", tool_call_id: "4", content: "kept-3" }
    ], 3);
    expect(compacted[2]?.content).toContain("omitted");
    expect(compacted[5]?.content).toBe("kept-3");
  });
});

describe("task branches", () => {
  it("names branches from the default branch and GitHub compare URLs", async () => {
    const { taskBranchName, packBranchName, parseGithubRepo, githubCompareUrl, detectDefaultBranch } = await import("../src/git/branch.js");
    expect(taskBranchName("ATS Resume", "taskabcdefgh", "Show loading spinner")).toBe("ai/ats-resume/show-loading-spinner-cdefgh");
    expect(packBranchName("ATS Resume", "taskabcdefgh", 3)).toBe("ai/ats-resume/3-improvements-cdefgh");
    expect(parseGithubRepo("git@github.com:Husaini1999/archivist.git")).toEqual({ owner: "Husaini1999", repo: "archivist" });
    expect(githubCompareUrl("https://github.com/Husaini1999/archivist.git", "main", "ai/x/y")).toContain("compare/main...ai%2Fx%2Fy");
    await run("git", ["-C", root, "checkout", "-b", "main"]).catch(() => undefined);
    expect(["main", "master"]).toContain(await detectDefaultBranch(root));
    const { commitMessage } = await import("../src/git/message.js");
    expect(commitMessage([
      "Improve AI API Key Error Feedback",
      "Enhance Resume Import Error Handling",
      "Add Loading and Empty States to AI Optimization"
    ])).toBe("feat: improve AI API Key Error Feedback, enhance Resume Import Error Handling, and add Loading and Empty States to AI Optimization");
    expect(commitMessage(["Improve AI API Key Error Feedback"])).toBe("feat: improve AI API Key Error Feedback");
    expect(commitMessage([
      "Improve AI API Key Error Feedback",
      "Enhance Resume Import Error Handling",
      "Add Loading and Empty States to AI Optimization"
    ])).not.toMatch(/Archivist|3 Archivist/i);
  });
});

describe("diff and checks", () => {
  it("includes new files inside a new untracked folder", async () => {
    await run("git", ["-C", root, "config", "user.email", "a@b.c"]);
    await run("git", ["-C", root, "config", "user.name", "t"]);
    await run("git", ["-C", root, "add", "package.json"]);
    await run("git", ["-C", root, "commit", "-m", "init"]);
    await fs.mkdir(path.join(root, "frontend", "src", "components"), { recursive: true });
    await fs.writeFile(path.join(root, "frontend", "src", "components", "LoadingOverlay.jsx"), "export default function LoadingOverlay() { return null; }\n");
    const { collectDiff } = await import("../src/orchestrator/diff.js");
    const diff = await collectDiff(root);
    expect(diff.files.some(file => file.file.replace(/\\/g, "/").includes("LoadingOverlay.jsx"))).toBe(true);
  });
  it("runs tests from a nested frontend package", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { start: "echo start" } }));
    await fs.mkdir(path.join(root, "frontend"), { recursive: true });
    await fs.writeFile(path.join(root, "frontend", "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
    const { runProjectChecks } = await import("../src/orchestrator/validate.js");
    const result = await runProjectChecks(root);
    expect(result.tested).toBe(true);
    expect(result.checks.find(check => check.name.includes("Tests"))?.status).toBe("passed");
  });
});
