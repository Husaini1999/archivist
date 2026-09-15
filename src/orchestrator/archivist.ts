import crypto from "node:crypto";
import path from "node:path";
import type { PrismaClient, Project } from "@prisma/client";
import { git } from "../git/git.js";
import { detectDefaultBranch, packBranchName, startTaskBranch, taskBranchName } from "../git/branch.js";
import { MemoryService, type DayLog } from "../memory/memory.js";
import { ApprovalService } from "../approvals/approval.js";
import { createAgentTools } from "../tools/registry.js";
import { AgentRuntime, iterationBudget, runTimeoutMs } from "../agents/runtime.js";
import type { LLMProvider } from "../integrations/llm.js";
import { isCancelled, throwIfAborted } from "../cancel.js";
import { inspectRepository } from "./inspect.js";
import { parseProposalList, SUGGEST_PROMPT } from "./proposal.js";
import { collectDiff } from "./diff.js";
import { runProjectChecks } from "./validate.js";

export function firstLine(text: string, max = 180) {
  const line = String(text ?? "").replace(/\r/g, "").split("\n").map(part => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function dateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export type ProgressFn = (message: string) => Promise<void> | void;

export class ArchivistOrchestrator {
  private readonly memory: MemoryService;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly home: string,
    private readonly approvals: ApprovalService,
    private readonly llm?: LLMProvider,
    private readonly softwareRoot: string = home
  ) {
    this.memory = new MemoryService(home);
  }

  async analyze(project: Project, onProgress?: ProgressFn, signal?: AbortSignal) {
    throwIfAborted(signal);
    await onProgress?.("Reading the repository…");
    const status = await git(project.gitRoot, ["status", "--short"]).catch(() => "");
    const memory = await this.memory.readRelevant(project.slug).catch(() => []);
    await onProgress?.("Sampling the codebase…");
    const inspection = await inspectRepository(project.gitRoot, signal);
    const today = await this.memory.readDay(project.slug, dateKey(new Date(), "UTC"));
    const analysis = [
      `Project: ${project.name} (${project.slug})`,
      `Technology: ${project.technology}. Branch: ${project.branch}. Working tree: ${status || "clean"}.`,
      memory.length ? `Archivist memory:\n${memory.map(item => `${item.name}:\n${item.content.slice(0, 800)}`).join("\n")}` : "",
      today.trim() ? `Already noted today (do not repeat these ideas):\n${today.slice(0, 2500)}` : "",
      inspection
    ].filter(Boolean).join("\n\n");
    await this.note(project, "Analysis", "SUCCEEDED", `${project.technology} · ${project.branch} · ${status || "clean"}`);
    return analysis;
  }

  async suggest(project: Project, onProgress?: ProgressFn, signal?: AbortSignal) {
    const analysis = await this.analyze(project, onProgress, signal);
    const heuristic = !this.llm;
    const drafts: { title: string; summary: string; evidence: string; expected: string }[] = [];
    if (this.llm) {
      this.llm.onWait = seconds => { void onProgress?.(`OpenAI rate limit — waiting ${seconds}s to stay under tokens/min…`); };
      throwIfAborted(signal);
      await onProgress?.("Asking the model for a recommendation…");
      const answer = await this.llm.chat([{ role: "system", content: SUGGEST_PROMPT }, { role: "user", content: analysis.slice(0, 10_000) }], [], signal);
      for (const parsed of parseProposalList(answer.content)) {
        drafts.push({
          title: parsed.title,
          summary: parsed.solution && parsed.solution !== "Not specified" ? parsed.solution : parsed.summary,
          evidence: [parsed.problem, parsed.evidence].filter(part => part && part !== "Not specified").join("\n") || parsed.evidence,
          expected: parsed.expected
        });
      }
    } else {
      await onProgress?.("Building a heuristic recommendation…");
      drafts.push({
        title: "Clarify loading and error feedback on a primary flow",
        summary: "• Show loading and error UI for the slowest user action\n• Reuse existing components instead of a new state system",
        evidence: "• Sampled UI/API files show a user flow that can fail without clear feedback",
        expected: "• Users can tell what is happening when work is in progress or fails"
      });
      if (!/"test"\s*:/.test(analysis)) {
        drafts.push({
          title: "Add a smoke test for a core user flow",
          summary: "• Add one automated test around the main user path\n• Keep it inside the existing test setup if present",
          evidence: "• No clear test script showed up in the sampled package.json",
          expected: "• Later Archivist changes are safer to approve"
        });
      }
    }
    throwIfAborted(signal);
    await onProgress?.("Saving the recommendation…");
    const saved = [];
    for (const draft of drafts.slice(0, 3)) {
      const fingerprint = crypto.createHash("sha256").update(`${project.id}:${draft.title}:${draft.evidence}`).digest("hex");
      const prior = await this.prisma.proposal.findFirst({ where: { projectId: project.id, fingerprint, status: { in: ["PENDING", "REJECTED"] } } });
      if (prior) { saved.push(prior); continue; }
      const proposal = await this.prisma.proposal.create({ data: {
        projectId: project.id, ...draft, heuristic,
        metricsJson: JSON.stringify({ productImpact: "estimated medium", engineeringImpact: "estimated medium", effort: "estimated medium", risk: "estimated low", confidence: heuristic ? "heuristic" : "model-estimated" }),
        agentsJson: JSON.stringify(["backend"]), fingerprint
      } });
      saved.push(proposal);
    }
    if (!saved.length) throw new Error("No recommendations produced");
    const recLog: Partial<DayLog> = {
      problems: saved.map(item => firstLine(item.evidence)).filter(Boolean),
      recommendations: saved.map(item => [
        item.title,
        firstLine(item.evidence) ? `Problem: ${firstLine(item.evidence)}` : "",
        firstLine(item.summary) ? `Change: ${firstLine(item.summary)}` : ""
      ].filter(Boolean).join("\n"))
    };
    await this.note(project, "Recommendation", "SUCCEEDED", saved.map(item => item.title).join("; "), recLog);
    return saved;
  }

  async work(taskId: string, onProgress?: ProgressFn, signal?: AbortSignal, alsoTaskIds: string[] = []) {
    const ids = [taskId, ...alsoTaskIds.filter(id => id !== taskId)];
    const loaded = [];
    for (const id of ids) {
      const task = await this.prisma.task.findUnique({ where: { id }, include: { project: true, proposal: true } });
      if (!task || task.status !== "APPROVED") throw new Error("Task is not approved and ready");
      loaded.push(task);
    }
    const task = loaded[0]!;
    const project = task.project;
    if (loaded.some(item => item.projectId !== project.id)) throw new Error("Accepted recommendations must belong to the same project");
    if (project.paused) throw new Error("Project is paused; approved task remains queued");
    const settings = await this.prisma.scheduleSettings.findUnique({ where: { id: 1 } });
    if (settings?.globalPaused) throw new Error("Automation is globally paused; approved task remains queued");
    throwIfAborted(signal);
    await onProgress?.("Checking out the default branch…");
    const base = await detectDefaultBranch(project.gitRoot);
    const branch = loaded.length > 1
      ? packBranchName(project.slug, task.id, loaded.length)
      : taskBranchName(project.slug, task.id, task.proposal.title);
    await onProgress?.(`Creating ${branch} from ${base}…`);
    await startTaskBranch(project.gitRoot, branch, base);
    await this.prisma.task.updateMany({ where: { id: { in: ids } }, data: { status: "RUNNING", branch } });
    if (!this.llm) throw new Error("LLM key required for implementation; analysis remains available offline");
    this.llm.onWait = seconds => { void onProgress?.(`OpenAI rate limit — waiting ${seconds}s to stay under tokens/min…`); };
    const runtime = new AgentRuntime(this.llm, createAgentTools(project.gitRoot), path.join(this.softwareRoot, "prompts"), iterationBudget(loaded.length), runTimeoutMs(loaded.length));
    const brief = loaded.map((item, index) => `${index + 1}. ${item.proposal.title}\n${item.proposal.summary}\nEvidence: ${item.proposal.evidence}`).join("\n\n");
    throwIfAborted(signal);
    await onProgress?.(loaded.length > 1 ? `Implementing ${loaded.length} accepted recs in one pass…` : "Implementing the recommendation…");
    const run = await this.prisma.agentRun.create({ data: { taskId: task.id, role: "backend", status: "RUNNING" } });
    try {
      const output = await runtime.run(
        "backend",
        `Implement ALL of these accepted items in one pass on the current AI branch.\n\n${brief}\n\nRules:\n- Smallest possible diffs. Do not rewrite files or add extras.\n- Prefer editFile. Stay on this branch. Never commit or push.\n- Do not run tests; Archivist runs them after you finish.\n- Do not keep exploring after the edits. Return JSON {"summary":"...","completed":true,"findings":[]}.`,
        signal
      );
      throwIfAborted(signal);
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", outputJson: JSON.stringify(output) } });
    } catch (error) {
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", error: String(error) } });
      await this.prisma.task.updateMany({ where: { id: { in: ids } }, data: { status: isCancelled(error) ? "CANCELLED" : "FAILED" } });
      throw error;
    }
    throwIfAborted(signal);
    await onProgress?.("Running tests before PR approval…");
    const validation = await runProjectChecks(project.gitRoot, signal);
    throwIfAborted(signal);
    await onProgress?.("Collecting the diff…");
    const diff = await collectDiff(project.gitRoot);
    const titles = loaded.map(item => item.proposal.title);
    const report = {
      branch,
      base,
      changedFiles: diff.files,
      added: diff.added,
      deleted: diff.deleted,
      shortstat: diff.shortstat,
      checks: validation.checks,
      testsPassed: validation.testsPassed,
      tested: validation.tested,
      summary: loaded.map(item => item.proposal.summary).join("\n"),
      titles,
      relatedTaskIds: ids.slice(1),
      notice: `No commit has been made. Approving will not merge into ${base}.`
    };
    const reportJson = JSON.stringify(report);
    for (const id of ids) {
      await this.prisma.task.update({ where: { id }, data: { status: "AWAITING_COMMIT", branch, reportJson } });
    }
    await this.note(project, "Implementation", "SUCCEEDED", `${titles.join("; ")} — ${diff.files.length} files, +${diff.added} −${diff.deleted}`, {
      problems: loaded.map(item => firstLine(item.proposal.evidence)).filter(Boolean),
      recommendations: loaded.map(item => [
        item.proposal.title,
        firstLine(item.proposal.evidence) ? `Problem: ${firstLine(item.proposal.evidence)}` : "",
        firstLine(item.proposal.summary) ? `Change: ${firstLine(item.proposal.summary)}` : ""
      ].filter(Boolean).join("\n")),
      changes: diff.files.map(file => `${file.file}  +${file.added} −${file.deleted}`)
    });
    return { task: { ...task, branch }, report, approval: await this.approvals.create({ type: "COMMIT", projectId: project.id, taskId: task.id }) };
  }

  async note(project: { id: string; slug: string }, kind: string, status: string, summary = "", log?: Partial<DayLog>) {
    if (kind !== "Analysis") {
      await this.prisma.session.create({ data: { projectId: project.id, kind, status, summary: summary.slice(0, 2000) || null } });
    }
    const extra = kind === "Analysis" ? { lastAnalyzedAt: new Date(), lastSessionAt: new Date() } : { lastSessionAt: new Date() };
    await this.prisma.project.update({ where: { id: project.id }, data: extra });
    if (kind === "Analysis" || !log) return;
    await this.memory.upsertDay(project.slug, dateKey(new Date(), "UTC"), log);
  }

  async history(project: { id: string; slug: string }) {
    const days = await this.memory.listHistory(project.slug);
    return { memoryDir: this.memory.projectDir(project.slug), days };
  }
}
