import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { PrismaClient, Project, Task } from "@prisma/client";
import type { ApprovalService } from "../approvals/approval.js";
import type { ArchivistOrchestrator } from "../orchestrator/archivist.js";
import type { RecommendationSender } from "../scheduler/scheduler.js";
import { isCancelled } from "../cancel.js";
import { redact } from "../security/redact.js";
import { PrivilegedGitService } from "../git/git.js";
import { commitMessage, commitSubject } from "../git/message.js";
import { escapeHtml, formatFileDiff, formatImplementationReport, formatProjectHistory, formatProposalDetails, formatProposalList, formatProposalMessage } from "./format.js";
import { allDecided, buildPackKeyboard, parsePackCallback, setPackDecision, type RecPack } from "./pack.js";
import { collectDiff, filePatch } from "../orchestrator/diff.js";

export const BOT_COMMANDS = [
  { command: "start", description: "Show commands and how to use the bot" },
  { command: "projects", description: "List registered projects" },
  { command: "status", description: "Same as /projects" },
  { command: "enable", description: "Turn on 8am suggestions: /enable {project}" },
  { command: "disable", description: "Turn off 8am suggestions: /disable {project}" },
  { command: "now", description: "Suggest an improvement now: /now {project}" },
  { command: "history", description: "Recent sessions: /history {project}" },
  { command: "pause", description: "Pause a project or all automation" },
  { command: "resume", description: "Resume a project or all automation" },
  { command: "cancel", description: "Stop the current analysis or implementation" }
] as const;

const HELP = `Archivist commands

/projects — list projects on this machine (○ off, ✅ daily on, ⏸ paused)
/enable {project} — 8am suggestions for that project
/disable {project}
/now {project} — send a recommendation now
/history {project}
/pause and /resume — all automation
/pause {project} and /resume {project} — one project
/cancel — stop the current analysis or implementation

{project} is the slug from /projects, for example husaini-dev-portfolio.

This bot talks to the Archivist daemon on your PC. If the PC is off, commands will not work.

For several recommendations, mark each ✅ or ❌, then tap Apply. Accepted recs share one branch from main/master and one PR. Archivist does not merge into production.`;

const PROJECT_ACTIONS = ["now", "enable", "disable", "history", "pause", "resume"] as const;
type ProjectAction = typeof PROJECT_ACTIONS[number];

export function parseProjectCommand(text: string): { command: string; project?: string } {
  const [command = "", ...rest] = text.trim().split(/\s+/);
  return { command: command.replace(/^\//, "").split("@")[0]!.toLowerCase(), project: rest.join(" ") || undefined };
}

export function parseProjectPicker(data: string): { action: string; projectId: string } | null {
  const match = /^p:(now|enable|disable|history|pause|resume|menu):(.+)$/.exec(data);
  return match ? { action: match[1]!, projectId: match[2]! } : null;
}

export function cancelKeyboard(jobId: string) {
  return new InlineKeyboard().text("❌ Cancel", `x:${jobId}`);
}

export function buildProjectPicker(projects: { id: string; slug: string; paused?: boolean; autoImproveEnabled?: boolean }[], action: ProjectAction | "menu") {
  const keyboard = new InlineKeyboard();
  if (!projects.length) return keyboard;
  for (const [index, project] of projects.entries()) {
    const mark = project.paused ? "⏸ " : project.autoImproveEnabled ? "✅ " : "○ ";
    keyboard.text(`${mark}${project.slug}`.slice(0, 64), `p:${action}:${project.id}`);
    if (index % 2 === 1 || index === projects.length - 1) keyboard.row();
  }
  return keyboard;
}

class LiveStatus {
  private messageId?: number;
  private typing?: ReturnType<typeof setInterval>;
  constructor(private readonly ctx: Context, private readonly chatId: number | string, private readonly jobId?: string) {}

  private markup() {
    return this.jobId ? cancelKeyboard(this.jobId) : undefined;
  }

  async start(text: string) {
    await this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => undefined);
    const sent = await this.ctx.reply(`⏳ ${text}`, { reply_markup: this.markup() });
    this.messageId = sent.message_id;
    this.typing = setInterval(() => {
      this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => undefined);
    }, 4000);
    return async (next: string) => { await this.update(next); };
  }

  async update(text: string): Promise<void> {
    if (!this.messageId) {
      await this.start(text);
      return;
    }
    await this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => undefined);
    await this.ctx.api.editMessageText(this.chatId, this.messageId, `⏳ ${text}`, { reply_markup: this.markup() }).catch(() => undefined);
  }

  async succeed(text: string) {
    this.stopTyping();
    if (this.messageId) await this.ctx.api.editMessageText(this.chatId, this.messageId, `✅ ${text}`, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }

  async fail(text: string, cancelled = false) {
    this.stopTyping();
    const line = `${cancelled ? "⏹" : "❌"} ${text}`;
    if (this.messageId) await this.ctx.api.editMessageText(this.chatId, this.messageId, line, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
    else await this.ctx.reply(line);
  }

  private stopTyping() {
    if (this.typing) clearInterval(this.typing);
    this.typing = undefined;
  }
}

export class TelegramService implements RecommendationSender {
  readonly bot: Bot;
  private readonly jobs = new Map<string, { id: string; abort: AbortController }>();
  private readonly packs = new Map<string, RecPack>();
  constructor(token: string, private readonly prisma: PrismaClient, private readonly approvals: ApprovalService, private readonly orchestrator: ArchivistOrchestrator, private readonly allowed: Set<string>, private readonly chatId?: string) {
    this.bot = new Bot(token);
    this.install();
  }

  async sendProposal(projectName: string, p: { id: string; title: string; summary: string; evidence: string; expected: string }, token: string, chatId = this.chatId) {
    return this.sendProposals(projectName, [{ proposal: p, token }], chatId);
  }

  async sendProposals(projectName: string, items: { proposal: { id: string; title: string; summary: string; evidence: string; expected: string }; token: string }[], chatId = this.chatId) {
    if (!chatId || !items.length) return undefined;
    if (items.length === 1) {
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", `a:${items[0]!.token}`).text("❌ Decline", `d:${items[0]!.token}`).row()
        .text("🔍 Details", `i:${items[0]!.proposal.id}`);
      const message = await this.bot.api.sendMessage(chatId, redact(formatProposalMessage(projectName, items[0]!.proposal)), { reply_markup: keyboard, parse_mode: "HTML" });
      return String(message.message_id);
    }
    const pack: RecPack = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 12),
      projectName,
      items: items.map(item => ({ ...item, decision: "pending" as const }))
    };
    this.packs.set(pack.id, pack);
    const body = formatProposalList(projectName, pack.items.map(item => item.proposal), pack.items.map(item => item.decision));
    const message = await this.bot.api.sendMessage(chatId, redact(body), { reply_markup: buildPackKeyboard(pack), parse_mode: "HTML" });
    return String(message.message_id);
  }

  private userId(ctx: Context) { return String(ctx.from?.id ?? ""); }

  private beginJob(ctx: Context) {
    const key = this.userId(ctx);
    const previous = this.jobs.get(key);
    previous?.abort.abort();
    const abort = new AbortController();
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    this.jobs.set(key, { id, abort });
    return { id, signal: abort.signal, replaced: Boolean(previous) };
  }

  private finishJob(ctx: Context, id: string) {
    const key = this.userId(ctx);
    const current = this.jobs.get(key);
    if (current?.id === id) this.jobs.delete(key);
  }

  private cancelJob(ctx: Context, jobId?: string) {
    const key = this.userId(ctx);
    const current = this.jobs.get(key);
    if (!current || (jobId && current.id !== jobId)) return false;
    current.abort.abort();
    return true;
  }

  private runInBackground(ctx: Context, work: (signal: AbortSignal, status: LiveStatus) => Promise<void>) {
    const job = this.beginJob(ctx);
    const status = new LiveStatus(ctx, ctx.chat?.id ?? this.chatId ?? "", job.id);
    void (async () => {
      if (job.replaced) await ctx.reply("⏹ Stopped the previous run so this one can start.");
      try {
        await work(job.signal, status);
      } catch (error) {
        if (isCancelled(error) || job.signal.aborted) await status.fail("Cancelled.", true);
        else await status.fail(redact(String(error)));
      } finally {
        this.finishJob(ctx, job.id);
      }
    })();
    return job;
  }

  private install() {
    this.bot.use(async (ctx, next) => {
      const id = String(ctx.from?.id ?? "");
      if (!this.allowed.has(id)) {
        await ctx.reply(`Unauthorized. Your Telegram user id is ${id}. Put only that number in TELEGRAM_ALLOWED_USER_IDS (not the bot token) and restart the daemon.`);
        return;
      }
      await next();
    });
    this.bot.command(["start", "help"], async ctx => { await ctx.reply(HELP); });
    this.bot.command("cancel", async ctx => {
      if (this.cancelJob(ctx)) await ctx.reply("⏹ Cancelling the current run…");
      else await ctx.reply("Nothing is running.");
    });
    this.bot.command(["projects", "status"], async ctx => {
      const projects = await this.prisma.project.findMany({ orderBy: { name: "asc" } });
      if (!projects.length) { await ctx.reply("No projects registered. Run archivist projects scan on your PC."); return; }
      await ctx.reply(projects.map(p => `${p.paused ? "⏸" : p.autoImproveEnabled ? "✅" : "○"} ${p.slug}`).join("\n") + "\n\nTap a project:", { reply_markup: buildProjectPicker(projects, "menu") });
    });
    this.bot.command(["enable", "disable", "pause", "resume", "now", "history"], async ctx => {
      const parsed = parseProjectCommand(ctx.message?.text ?? "");
      if (!parsed.project && ["pause", "resume"].includes(parsed.command)) {
        await this.prisma.scheduleSettings.upsert({ where: { id: 1 }, create: { id: 1, globalPaused: parsed.command === "pause" }, update: { globalPaused: parsed.command === "pause" } });
        await ctx.reply(parsed.command === "pause" ? "⏸ Automation paused globally." : "▶️ Automation resumed globally.");
        return;
      }
      if (!parsed.project || !(await this.resolve(parsed.project))) {
        await this.askProject(ctx, parsed.command as ProjectAction, parsed.project ? `Unknown project "${parsed.project}". Pick one:` : `Choose a project for /${parsed.command}:`);
        return;
      }
      this.runProjectAction(ctx, parsed.command as ProjectAction, (await this.resolve(parsed.project))!);
    });
    this.bot.callbackQuery(/^x:(.+)$/, async ctx => {
      const stopped = this.cancelJob(ctx, ctx.match![1]);
      await ctx.answerCallbackQuery({ text: stopped ? "Cancelling…" : "Nothing to cancel" });
      if (stopped) await ctx.reply("⏹ Cancelling the current run…");
    });
    this.bot.callbackQuery(/^p:(now|enable|disable|history|pause|resume|menu):(.+)$/, async ctx => {
      const picked = parseProjectPicker(ctx.callbackQuery.data ?? "");
      if (!picked) { await ctx.answerCallbackQuery(); return; }
      const project = await this.prisma.project.findUnique({ where: { id: picked.projectId } });
      if (!project) { await ctx.answerCallbackQuery({ text: "Project not found", show_alert: true }); return; }
      if (picked.action === "menu") {
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard()
          .text("⚡ Now", `p:now:${project.id}`).text("📜 History", `p:history:${project.id}`).row()
          .text("🟢 Enable", `p:enable:${project.id}`).text("⚪ Disable", `p:disable:${project.id}`).row()
          .text("⏸ Pause", `p:pause:${project.id}`).text("▶️ Resume", `p:resume:${project.id}`);
        await ctx.reply(`📁 ${project.slug}\nChoose an action:`, { reply_markup: keyboard });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Working…" });
      this.runProjectAction(ctx, picked.action as ProjectAction, project);
    });
    this.bot.callbackQuery(/^f:(.+):(\d+)$/, async ctx => {
      await ctx.answerCallbackQuery({ text: "Loading file diff…" });
      const task = await this.prisma.task.findUnique({ where: { id: ctx.match![1] }, include: { project: true } });
      if (!task) { await ctx.reply("Task not found."); return; }
      const diff = await collectDiff(task.project.gitRoot);
      const file = diff.files[Number(ctx.match![2])];
      if (!file) { await ctx.reply("File not found in the current diff."); return; }
      const patch = await filePatch(task.project.gitRoot, file.file);
      await ctx.reply(redact(formatFileDiff(file.file, file.added, file.deleted, patch)), { parse_mode: "HTML" });
    });
    this.bot.callbackQuery(/^[srg]:/, async ctx => {
      const parsed = parsePackCallback(ctx.callbackQuery.data ?? "");
      if (!parsed) { await ctx.answerCallbackQuery(); return; }
      const pack = this.packs.get(parsed.packId);
      if (!pack) {
        await ctx.answerCallbackQuery({ text: "This selection expired. Request recommendations again.", show_alert: true });
        return;
      }
      if (parsed.kind === "accept" || parsed.kind === "decline") {
        setPackDecision(pack, parsed.index ?? -1, parsed.kind === "accept" ? "accepted" : "declined");
        const n = (parsed.index ?? 0) + 1;
        await ctx.answerCallbackQuery({ text: parsed.kind === "accept" ? `${n} accepted` : `${n} declined` });
        const body = formatProposalList(pack.projectName, pack.items.map(item => item.proposal), pack.items.map(item => item.decision));
        await ctx.editMessageText(redact(body), { reply_markup: buildPackKeyboard(pack), parse_mode: "HTML" }).catch(() => undefined);
        return;
      }
      if (!allDecided(pack)) {
        await ctx.answerCallbackQuery({ text: "Choose accept or decline for every recommendation first.", show_alert: true });
        return;
      }
      try {
        const userId = String(ctx.from.id);
        const accepted = pack.items.filter(item => item.decision === "accepted");
        const declined = pack.items.filter(item => item.decision === "declined");
        for (const item of declined) await this.approvals.decide(item.token, userId, "REJECTED");
        const tasks: Task[] = [];
        for (const item of accepted) {
          const decided = await this.approvals.decide(item.token, userId, "APPROVED");
          const task = await this.prisma.task.findFirst({ where: { proposalId: decided.proposalId! }, orderBy: { createdAt: "desc" } });
          if (task) tasks.push(task);
        }
        this.packs.delete(pack.id);
        await ctx.answerCallbackQuery({ text: accepted.length ? "Applying…" : "All declined" });
        await ctx.editMessageReplyMarkup();
        if (!tasks.length) {
          await ctx.reply("❌ All recommendations declined. Nothing will be implemented.");
          return;
        }
        this.runInBackground(ctx, async (signal, status) => {
          const onProgress = await status.start(tasks.length > 1
            ? `Implementing ${tasks.length} accepted recommendations on one branch from main/master…`
            : "Starting implementation…");
          const completed = await this.orchestrator.work(tasks[0]!.id, onProgress, signal, tasks.slice(1).map(item => item.id));
          await status.succeed("Implementation complete. Review the combined diff, then approve once to open a single PR.");
          await this.replyWithImplementation(ctx, completed);
        });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: String(error), show_alert: true });
      }
    });
    this.bot.callbackQuery(/^([adiv]):(.+)$/, async ctx => {
      const [, action, value] = ctx.match!;
      if (action === "v") {
        await ctx.answerCallbackQuery({ text: "Loading diff…" });
        const task = await this.prisma.task.findUnique({ where: { id: value }, include: { project: true } });
        if (!task) { await ctx.reply("Task not found."); return; }
        const diff = await collectDiff(task.project.gitRoot);
        const summary = diff.files.map(file => `${file.file}  +${file.added} −${file.deleted}`).join("\n") || "No uncommitted diff.";
        await ctx.reply(redact(`<b>Diff on ${escapeHtml(task.branch || "HEAD")}</b>\n<code>${escapeHtml(summary)}</code>\n\n<i>Tap a file button on the report for line-by-line changes. GitHub cannot show this until the branch is pushed.</i>`), { parse_mode: "HTML" }); return;
      }
      if (action === "i") {
        await ctx.answerCallbackQuery({ text: "Loading details…" });
        const p = await this.prisma.proposal.findUnique({ where: { id: value } });
        await ctx.reply(p ? formatProposalDetails(p) : "Proposal not found.", { parse_mode: "HTML" }); return;
      }
      try {
        const decided = await this.approvals.decide(value!, String(ctx.from.id), action === "a" ? "APPROVED" : "REJECTED");
        await ctx.answerCallbackQuery({ text: action === "a" ? "Working…" : "Declined" });
        await ctx.editMessageReplyMarkup();
        if (action === "d") {
          const declined = decided.taskId
            ? await this.prisma.task.findUnique({ where: { id: decided.taskId }, include: { project: true } })
            : decided.proposalId
              ? await this.prisma.proposal.findUnique({ where: { id: decided.proposalId }, include: { project: true } })
              : null;
          if (declined?.project) {
            const title = "title" in declined ? declined.title : "Commit/PR declined";
            await this.orchestrator.note(declined.project, "Decline", "REJECTED", title, { declined: [title] });
          }
          await ctx.reply(decided.type === "PROPOSAL"
            ? "❌ Proposal declined. It will not be suggested again unless the repo changes."
            : "❌ Declined. The AI branch was kept locally. main/master was not changed.");
          return;
        }
        if (action === "a" && decided.type === "PROPOSAL" && decided.proposalId) {
          const task = await this.prisma.task.findFirst({ where: { proposalId: decided.proposalId }, orderBy: { createdAt: "desc" } });
          if (!task) return;
          this.runInBackground(ctx, async (signal, status) => {
            const onProgress = await status.start("Starting implementation…");
            const completed = await this.orchestrator.work(task.id, onProgress, signal);
            await status.succeed("Implementation complete. Review the diff, then approve once to open a PR.");
            await this.replyWithImplementation(ctx, completed);
          });
        } else if (action === "a" && decided.type === "COMMIT" && decided.taskId) {
          this.runInBackground(ctx, async (_signal, status) => {
            await status.start("Committing, pushing, and opening a pull request…");
            const task = await this.prisma.task.findUnique({ where: { id: decided.taskId! }, include: { project: true, proposal: true } });
            if (!task) throw new Error("Task not found.");
            const report = JSON.parse(task.reportJson || "{}") as { tested?: boolean; testsPassed?: boolean; branch?: string; base?: string; titles?: string[]; relatedTaskIds?: string[] };
            if (report.tested && report.testsPassed === false) throw new Error("Tests failed; commit is blocked.");
            const base = report.base || "main";
            const titles = report.titles?.length ? report.titles : [task.proposal.title];
            const published = await new PrivilegedGitService(this.prisma).publish(task.projectId, task.project.gitRoot, decided.id, {
              message: commitMessage(titles),
              base,
              title: commitMessage(titles),
              body: commitSubject(titles)
            });
            const related = [task.id, ...(report.relatedTaskIds ?? [])];
            await this.prisma.task.updateMany({ where: { id: { in: related } }, data: { status: "COMMITTED" } });
            await this.orchestrator.note(
              task.project,
              "PullRequest",
              "SUCCEEDED",
              `${published.branch} → ${base}${published.prUrl ? `\n${published.prUrl}` : ""}`,
              {
                outcome: [
                  `${published.branch} → ${base}`,
                  published.prUrl || "Branch pushed; open the PR on GitHub.",
                  ...titles.map(title => `Accepted: ${title}`)
                ]
              }
            );
            await status.succeed(`Committed ${published.hash.slice(0, 12)} on ${published.branch}.`);
            const prLine = published.prUrl
              ? `Pull request: ${escapeHtml(published.prUrl)}`
              : `Branch pushed. Open a PR on GitHub into <code>${escapeHtml(base)}</code> (install GitHub CLI with <code>gh auth login</code> to create it automatically next time).`;
            await ctx.reply(
              `✅ One PR opened into <code>${escapeHtml(base)}</code>\n<code>${escapeHtml(published.branch)}</code> was pushed with the combined accepted work.\n${prLine}\n\n⚠️ <b>${escapeHtml(base)} / production was NOT merged.</b> Merge the PR on GitHub if you want it live.`,
              { parse_mode: "HTML" }
            );
          });
        } else if (action === "a" && decided.type === "PUSH" && decided.taskId) {
          this.runInBackground(ctx, async (_signal, status) => {
            await status.start("Pushing the AI branch…");
            const task = await this.prisma.task.findUnique({ where: { id: decided.taskId! }, include: { project: true } });
            if (!task) throw new Error("Task not found.");
            await new PrivilegedGitService(this.prisma).push(task.projectId, task.project.gitRoot, decided.id);
            await status.succeed(`Pushed ${task.branch || "HEAD"}. Open a pull request on GitHub. main/master was not merged.`);
          });
        }
      } catch (error) { await ctx.answerCallbackQuery({ text: String(error), show_alert: true }); }
    });
  }

  private async replyWithImplementation(ctx: Context, completed: Awaited<ReturnType<ArchivistOrchestrator["work"]>>) {
    const report = completed.report;
    const taskId = completed.task.id;
    const keyboard = new InlineKeyboard();
    for (const [index, file] of (report.changedFiles ?? []).slice(0, 8).entries()) {
      const label = `${path.basename(file.file)} +${file.added}/−${file.deleted}`.slice(0, 64);
      keyboard.text(`📄 ${label}`, `f:${taskId}:${index}`);
      if (index % 2 === 1) keyboard.row();
    }
    keyboard.row().text("📋 Diff summary", `v:${taskId}`).row();
    if (report.tested && report.testsPassed === false) {
      keyboard.text("❌ Decline", `d:${completed.approval.callbackToken}`);
    } else {
      keyboard.text("✅ Open PR (does not merge)", `a:${completed.approval.callbackToken}`).text("❌ Decline", `d:${completed.approval.callbackToken}`);
    }
    await ctx.reply(redact(formatImplementationReport(completed.task.project.name, {
      branch: report.branch,
      base: report.base,
      summary: report.summary,
      files: report.changedFiles,
      added: report.added,
      deleted: report.deleted,
      checks: report.checks,
      testsPassed: report.testsPassed,
      tested: report.tested
    })), { reply_markup: keyboard, parse_mode: "HTML" });
  }

  private async askProject(ctx: Context, action: ProjectAction, prompt: string) {
    const projects = await this.prisma.project.findMany({ orderBy: { name: "asc" } });
    if (!projects.length) { await ctx.reply("No projects registered. Run archivist projects scan on your PC."); return; }
    await ctx.reply(prompt, { reply_markup: buildProjectPicker(projects, action) });
  }

  private runProjectAction(ctx: Context, command: ProjectAction, project: Project) {
    const chatId = String(ctx.chat?.id ?? this.chatId ?? "");
    if (command === "enable" || command === "disable") {
      void this.prisma.project.update({ where: { id: project.id }, data: { autoImproveEnabled: command === "enable" } })
        .then(() => ctx.reply(command === "enable" ? `🟢 ${project.slug}: 8am suggestions are on.` : `⚪ ${project.slug}: 8am suggestions are off.`));
      return;
    }
    if (command === "pause" || command === "resume") {
      void this.prisma.project.update({ where: { id: project.id }, data: { paused: command === "pause" } })
        .then(() => ctx.reply(command === "pause" ? `⏸ ${project.slug}: paused.` : `▶️ ${project.slug}: resumed.`));
      return;
    }
    if (command === "now") {
      this.runInBackground(ctx, async (signal, status) => {
        const onProgress = await status.start(`Analyzing ${project.slug}…`);
        const proposals = await this.orchestrator.suggest(project, onProgress, signal);
        const items = [];
        for (const proposal of proposals) {
          const approval = await this.approvals.create({ type: "PROPOSAL", projectId: project.id, proposalId: proposal.id });
          items.push({ proposal, token: approval.callbackToken });
        }
        await status.succeed(proposals.length > 1 ? `${proposals.length} recommendations ready for ${project.slug}.` : `Recommendation ready for ${project.slug}.`);
        await this.sendProposals(project.name, items, chatId);
      });
      return;
    }
    this.runInBackground(ctx, async (_signal, status) => {
      await status.start(`Loading history for ${project.slug}…`);
      const history = await this.orchestrator.history(project);
      await status.succeed(`${project.slug} history`);
      await ctx.reply(redact(formatProjectHistory(project.slug, history.days)), { parse_mode: "HTML" });
    });
  }

  private async resolve(value?: string) {
    if (!value) return null;
    const projects = await this.prisma.project.findMany();
    const needle = value.toLowerCase();
    return projects.find(p => p.slug.toLowerCase() === needle || p.name.toLowerCase() === needle) ?? null;
  }
  async start() {
    await this.bot.api.setMyCommands([...BOT_COMMANDS]);
    return this.bot.start();
  }
}
