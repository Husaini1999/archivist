#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { db, closeDb } from "../repositories/db.js";
import { loadConfig } from "../config/index.js";
import { findGitRoot, git, PrivilegedGitService } from "../git/git.js";
import { registerProject, scanProjects } from "../discovery/projects.js";
import { MemoryService } from "../memory/memory.js";
import { ApprovalService } from "../approvals/approval.js";
import { ArchivistOrchestrator } from "../orchestrator/archivist.js";
import { OpenAICompatibleProvider } from "../integrations/llm.js";
import { DailyScheduler, type RecommendationSender } from "../scheduler/scheduler.js";
import { TelegramService } from "../telegram/bot.js";

const config = loadConfig(), prisma = db();
const cliUsers = new Set([...config.allowedUserIds, "cli"]);
const approvals = new ApprovalService(prisma, cliUsers, config.approvalTtlHours);
const llm = config.llm.apiKey && config.llm.model ? new OpenAICompatibleProvider(config.llm.baseUrl, config.llm.apiKey, config.llm.model) : undefined;
const orchestrator = new ArchivistOrchestrator(prisma, config.home, approvals, llm);
const output = (value: unknown, json = false) => console.log(json ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function selected(options: { repo?: string; project?: string }) {
  if (options.project) {
    const all = await prisma.project.findMany(), needle = options.project.toLowerCase();
    const found = all.find(p => p.slug.toLowerCase() === needle || p.name.toLowerCase() === needle);
    if (!found) throw new Error(`Unknown project: ${options.project}`);
    return found;
  }
  const root = await findGitRoot(options.repo ?? process.cwd());
  if (!root) throw new Error("Not inside a registered Git repository; use --project or archivist init");
  const project = await prisma.project.findUnique({ where: { gitRoot: root } });
  if (!project) throw new Error("Repository is not registered; run archivist init");
  return project;
}

const program = new Command().name("archivist").description("Human-governed AI repository maintenance").option("--repo <path>").option("--project <name>").option("--json");

program.command("init").description("Register current repository").action(async () => {
  const o = program.opts(); const project = await registerProject(prisma, o.repo ?? process.cwd());
  await new MemoryService(config.home).ensure(project.slug);
  output({ registered: project.slug, root: project.gitRoot, memory: path.join(config.home, "memory", "projects", project.slug) }, o.json);
});
const projects = program.command("projects").description("List projects").action(async () => {
  const o = program.opts(); output(await prisma.project.findMany({ orderBy: { name: "asc" } }), o.json);
});
projects.command("scan").action(async () => output(await scanProjects(prisma, config.projectRoots, config.home), program.opts().json));
program.command("analyze").action(async () => { const o = program.opts(); output(await orchestrator.analyze(await selected(o)), o.json); });
program.command("suggest").action(async () => { const o = program.opts(); const p = await selected(o); const proposal = await orchestrator.suggest(p); const approval = await approvals.create({ type: "PROPOSAL", projectId: p.id, proposalId: proposal.id }); output({ proposal, approvalToken: approval.callbackToken }, o.json); });
program.command("daily").action(async () => {
  const sender: RecommendationSender = { sendProposal: async (name, p, token) => { console.log(`${name}: ${p.title}\nApprove: archivist approve ${token}`); return undefined; } };
  output(await new DailyScheduler(prisma, orchestrator, sender, config.timezone).run(), program.opts().json);
});
program.command("work [task]").action(async task => {
  const o = program.opts(); const p = await selected(o); const found = task ? await prisma.task.findUnique({ where: { id: task } }) : await prisma.task.findFirst({ where: { projectId: p.id, status: "APPROVED" }, orderBy: { createdAt: "asc" } });
  if (!found) throw new Error("No approved task"); output(await orchestrator.work(found.id), o.json);
});
program.command("status").action(async () => { const o = program.opts(); const p = await selected(o); output({ project: p.slug, paused: p.paused, autoImprove: p.autoImproveEnabled, branch: await git(p.gitRoot, ["branch", "--show-current"]), git: await git(p.gitRoot, ["status", "--short"]) }, o.json); });
program.command("history").action(async () => { const o = program.opts(); const p = await selected(o); output(await prisma.session.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, take: 20 }), o.json); });
program.command("diff").action(async () => { const o = program.opts(); output(await git((await selected(o)).gitRoot, ["diff"]), o.json); });
program.command("test").action(async () => { const o = program.opts(); output(await git((await selected(o)).gitRoot, ["status", "--short"]) + "\nRun the repository's documented test command.", o.json); });
program.command("review").action(async () => { const o = program.opts(); const p = await selected(o); output({ diffStat: await git(p.gitRoot, ["diff", "--stat"]), note: "Review approval remains human-controlled." }, o.json); });
program.command("approve [token]").action(async token => {
  const pending = token ? await prisma.approval.findUnique({ where: { callbackToken: token } }) : await prisma.approval.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "desc" } });
  if (!pending) throw new Error("No pending approval");
  const decided = await approvals.decide(pending.callbackToken, "cli", "APPROVED");
  if (decided.type === "COMMIT" && decided.taskId) {
    const task = await prisma.task.findUnique({ where: { id: decided.taskId }, include: { project: true, proposal: true } });
    if (task) output({ commit: await new PrivilegedGitService(prisma).commit(task.projectId, task.project.gitRoot, decided.id, `feat: ${task.proposal.title}`) }, program.opts().json);
  } else output(decided, program.opts().json);
});
program.command("reject [token]").action(async token => {
  const pending = token ? await prisma.approval.findUnique({ where: { callbackToken: token } }) : await prisma.approval.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "desc" } });
  if (!pending) throw new Error("No pending approval"); output(await approvals.decide(pending.callbackToken, "cli", "REJECTED"), program.opts().json);
});
for (const action of ["pause", "resume"] as const) program.command(action).action(async () => {
  const o = program.opts();
  if (o.project || o.repo) { const p = await selected(o); await prisma.project.update({ where: { id: p.id }, data: { paused: action === "pause" } }); }
  else await prisma.scheduleSettings.upsert({ where: { id: 1 }, create: { id: 1, globalPaused: action === "pause" }, update: { globalPaused: action === "pause" } });
  output(`Automation ${action}d.`, o.json);
});
program.command("daemon").action(async () => {
  if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const chatId = [...config.allowedUserIds][0], telegram = new TelegramService(config.telegramToken, prisma, approvals, orchestrator, config.allowedUserIds, chatId);
  new DailyScheduler(prisma, orchestrator, telegram, config.timezone).start();
  console.log(`Archivist daemon running (${config.timezone}, 08:00).`);
  await telegram.start();
});

program.action(async () => {
  const o = program.opts();
  const count = await prisma.project.count(), pending = await prisma.approval.count({ where: { status: "PENDING" } });
  output({ projects: count, pendingApprovals: pending, next: count ? "archivist status --project <slug>" : "Run archivist init inside a Git repository" }, o.json);
});

program.parseAsync().catch(error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }).finally(() => closeDb());
