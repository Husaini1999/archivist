import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient, Project } from "@prisma/client";
import { git } from "../git/git.js";
import { MemoryService } from "../memory/memory.js";
import { ApprovalService } from "../approvals/approval.js";
import { createAgentTools } from "../tools/registry.js";
import { AgentRuntime, type AgentRole } from "../agents/runtime.js";
import type { LLMProvider } from "../integrations/llm.js";

export function dateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export class ArchivistOrchestrator {
  private readonly memory: MemoryService;
  constructor(private readonly prisma: PrismaClient, private readonly home: string, private readonly approvals: ApprovalService, private readonly llm?: LLMProvider) {
    this.memory = new MemoryService(home);
  }

  async analyze(project: Project) {
    const files = await fs.readdir(project.gitRoot).catch(() => []);
    const status = await git(project.gitRoot, ["status", "--short"]).catch(() => "");
    const todos = await this.countTodos(project.gitRoot);
    const analysis = `Technology: ${project.technology}. Top-level entries: ${files.slice(0, 30).join(", ")}. Working tree: ${status || "clean"}. TODO/FIXME sample count: ${todos}.`;
    await this.memory.appendHistory(project.slug, dateKey(new Date(), "UTC"), "Analysis", analysis);
    await this.prisma.project.update({ where: { id: project.id }, data: { lastAnalyzedAt: new Date(), lastSessionAt: new Date() } });
    return analysis;
  }

  async suggest(project: Project) {
    const analysis = await this.analyze(project);
    let title: string, summary: string, evidence: string, expected: string, heuristic = !this.llm;
    if (this.llm) {
      const answer = await this.llm.chat([{ role: "system", content: "Return JSON with title, summary, evidence, expected. Metrics must be qualitative estimates." }, { role: "user", content: analysis }]);
      ({ title, summary, evidence, expected } = JSON.parse(answer.content) as { title: string; summary: string; evidence: string; expected: string });
    } else {
      const pkg = await fs.readFile(path.join(project.gitRoot, "package.json"), "utf8").catch(() => "");
      const hasTests = /"test"\s*:/.test(pkg);
      title = hasTests ? "Reduce highest-evidence technical debt" : "Add a repeatable automated test baseline";
      summary = hasTests ? "Review TODO/FIXME hotspots and address one well-scoped issue." : "Introduce a test runner and meaningful smoke tests for core behavior.";
      evidence = hasTests ? analysis : "No test script was detected in package.json.";
      expected = hasTests ? "Estimated: lower maintenance risk." : "Estimated: safer changes and earlier regressions.";
    }
    const fingerprint = crypto.createHash("sha256").update(`${project.id}:${title}:${evidence}`).digest("hex");
    const prior = await this.prisma.proposal.findFirst({ where: { projectId: project.id, fingerprint, status: { in: ["PENDING", "REJECTED"] } } });
    if (prior) return prior;
    const proposal = await this.prisma.proposal.create({ data: {
      projectId: project.id, title, summary, evidence, expected, heuristic,
      metricsJson: JSON.stringify({ productImpact: "estimated medium", engineeringImpact: "estimated medium", effort: "estimated medium", risk: "estimated low", confidence: heuristic ? "heuristic" : "model-estimated" }),
      agentsJson: JSON.stringify(["lead", "backend", "qa", "reviewer"]), fingerprint
    } });
    await this.memory.appendHistory(project.slug, dateKey(new Date(), "UTC"), "Recommendation", `${title}\n\n${summary}\n\nEvidence: ${evidence}`);
    return proposal;
  }

  async work(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: true, proposal: true } });
    if (!task || task.status !== "APPROVED") throw new Error("Task is not approved and ready");
    const project = task.project;
    if (project.paused) throw new Error("Project is paused; approved task remains queued");
    const settings = await this.prisma.scheduleSettings.findUnique({ where: { id: 1 } });
    if (settings?.globalPaused) throw new Error("Automation is globally paused; approved task remains queued");
    const branch = `ai/task-${task.id.slice(-6)}-${project.slug}`.slice(0, 70);
    const current = await git(project.gitRoot, ["branch", "--show-current"]);
    if (["main", "master"].includes(current)) await git(project.gitRoot, ["switch", "-c", branch]);
    await this.prisma.task.update({ where: { id: task.id }, data: { status: "RUNNING", branch } });
    if (!this.llm) throw new Error("LLM key required for implementation; analysis remains available offline");
    const runtime = new AgentRuntime(this.llm, createAgentTools(project.gitRoot), path.join(this.home, "prompts"));
    for (const role of ["lead", "backend", "qa", "reviewer"] as AgentRole[]) {
      const run = await this.prisma.agentRun.create({ data: { taskId: task.id, role, status: "RUNNING" } });
      try {
        const output = await runtime.run(role, `${task.proposal.title}\n${task.proposal.summary}\nOperate only in this repository. Never commit or push.`);
        await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", outputJson: JSON.stringify(output) } });
      } catch (error) {
        await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", error: String(error) } });
        await this.prisma.task.update({ where: { id: task.id }, data: { status: "FAILED" } });
        throw error;
      }
    }
    const diff = await git(project.gitRoot, ["diff", "--stat"]);
    const report = { changedFiles: diff, validation: "QA and reviewer agents completed", notice: "No commit has been made." };
    await this.prisma.task.update({ where: { id: task.id }, data: { status: "AWAITING_COMMIT", reportJson: JSON.stringify(report) } });
    await this.memory.appendHistory(project.slug, dateKey(new Date(), "UTC"), "Implementation", JSON.stringify(report, null, 2));
    return { task, report, approval: await this.approvals.create({ type: "COMMIT", projectId: project.id, taskId: task.id }) };
  }

  private async countTodos(root: string) {
    let count = 0;
    for (const entry of (await fs.readdir(root, { recursive: true })).map(String).filter(x => !x.includes("node_modules")).slice(0, 1000)) {
      try { if (/TODO|FIXME/.test(await fs.readFile(path.join(root, entry), "utf8"))) count++; } catch {}
    }
    return count;
  }
}
