import { Bot, InlineKeyboard } from "grammy";
import type { PrismaClient } from "@prisma/client";
import type { ApprovalService } from "../approvals/approval.js";
import type { ArchivistOrchestrator } from "../orchestrator/archivist.js";
import type { RecommendationSender } from "../scheduler/scheduler.js";
import { redact } from "../security/redact.js";
import { git, PrivilegedGitService } from "../git/git.js";

export function parseProjectCommand(text: string): { command: string; project?: string } {
  const [command = "", ...rest] = text.trim().split(/\s+/);
  return { command: command.replace(/^\//, "").split("@")[0]!.toLowerCase(), project: rest.join(" ") || undefined };
}

export class TelegramService implements RecommendationSender {
  readonly bot: Bot;
  constructor(token: string, private readonly prisma: PrismaClient, private readonly approvals: ApprovalService, private readonly orchestrator: ArchivistOrchestrator, private readonly allowed: Set<string>, private readonly chatId?: string) {
    this.bot = new Bot(token);
    this.install();
  }

  async sendProposal(projectName: string, p: { id: string; title: string; summary: string; evidence: string; expected: string }, token: string) {
    if (!this.chatId) return undefined;
    const keyboard = new InlineKeyboard().text("APPROVE", `a:${token}`).text("DECLINE", `d:${token}`).row().text("DETAILS", `i:${p.id}`);
    const message = await this.bot.api.sendMessage(this.chatId, redact(`🌅 ${projectName}\n\n${p.title}\n${p.summary}\n\nWhy: ${p.evidence}\nExpected: ${p.expected}\nMetrics are qualitative estimates.`), { reply_markup: keyboard });
    return String(message.message_id);
  }

  private install() {
    this.bot.use(async (ctx, next) => {
      const id = String(ctx.from?.id ?? "");
      if (!this.allowed.has(id)) { await ctx.reply("Unauthorized."); return; }
      await next();
    });
    this.bot.command(["projects", "status"], async ctx => {
      const projects = await this.prisma.project.findMany({ orderBy: { name: "asc" } });
      await ctx.reply(projects.length ? projects.map(p => `${p.paused ? "⏸" : p.autoImproveEnabled ? "✅" : "○"} ${p.slug}`).join("\n") : "No projects registered.");
    });
    this.bot.command(["enable", "disable", "pause", "resume", "now", "history"], async ctx => {
      const parsed = parseProjectCommand(ctx.message?.text ?? "");
      if (!parsed.project && ["pause", "resume"].includes(parsed.command)) {
        await this.prisma.scheduleSettings.upsert({ where: { id: 1 }, create: { id: 1, globalPaused: parsed.command === "pause" }, update: { globalPaused: parsed.command === "pause" } });
        await ctx.reply(`Automation ${parsed.command}d globally.`);
        return;
      }
      const project = await this.resolve(parsed.project);
      if (!project) { await ctx.reply("Project not found."); return; }
      if (parsed.command === "enable" || parsed.command === "disable") await this.prisma.project.update({ where: { id: project.id }, data: { autoImproveEnabled: parsed.command === "enable" } });
      else if (parsed.command === "pause" || parsed.command === "resume") await this.prisma.project.update({ where: { id: project.id }, data: { paused: parsed.command === "pause" } });
      else if (parsed.command === "now") {
        const p = await this.orchestrator.suggest(project), a = await this.approvals.create({ type: "PROPOSAL", projectId: project.id, proposalId: p.id });
        await this.sendProposal(project.name, p, a.callbackToken);
      } else {
        const sessions = await this.prisma.session.findMany({ where: { projectId: project.id }, take: 10, orderBy: { createdAt: "desc" } });
        await ctx.reply(sessions.map(s => `${s.createdAt.toISOString()} ${s.kind}: ${s.status}`).join("\n") || "No history.");
      }
      if (parsed.command !== "now" && parsed.command !== "history") await ctx.reply(`${project.slug}: ${parsed.command} applied.`);
    });
    this.bot.callbackQuery(/^([adiv]):(.+)$/, async ctx => {
      const [, action, value] = ctx.match!;
      if (action === "v") {
        const task = await this.prisma.task.findUnique({ where: { id: value }, include: { project: true } });
        const diff = task ? await git(task.project.gitRoot, ["diff", "--stat"]).catch(() => "Diff unavailable.") : "Task not found.";
        await ctx.answerCallbackQuery(); await ctx.reply(redact(diff || "No uncommitted diff.")); return;
      }
      if (action === "i") {
        const p = await this.prisma.proposal.findUnique({ where: { id: value } });
        await ctx.answerCallbackQuery(); await ctx.reply(p ? `${p.title}\n\n${p.evidence}\n\n${p.expected}` : "Proposal not found."); return;
      }
      try {
        const decided = await this.approvals.decide(value!, String(ctx.from.id), action === "a" ? "APPROVED" : "REJECTED");
        await ctx.answerCallbackQuery({ text: action === "a" ? "Approved" : "Declined" });
        await ctx.editMessageReplyMarkup();
        if (action === "a" && decided.type === "PROPOSAL" && decided.proposalId) {
          const task = await this.prisma.task.findFirst({ where: { proposalId: decided.proposalId }, orderBy: { createdAt: "desc" } });
          if (task) {
            try {
              const completed = await this.orchestrator.work(task.id);
              const keyboard = new InlineKeyboard().text("VIEW DIFF", `v:${task.id}`).row()
                .text("APPROVE COMMIT", `a:${completed.approval.callbackToken}`).text("DECLINE COMMIT", `d:${completed.approval.callbackToken}`);
              await ctx.reply(redact(`IMPLEMENTATION COMPLETE\n\nChanged files:\n${completed.report.changedFiles || "No diff"}\n\nValidation: ${completed.report.validation}\n${completed.report.notice}`), { reply_markup: keyboard });
            } catch (error) {
              await ctx.reply(`Task approved but queued/not completed: ${redact(String(error))}`);
            }
          }
        } else if (action === "a" && decided.type === "COMMIT" && decided.taskId) {
          const task = await this.prisma.task.findUnique({ where: { id: decided.taskId }, include: { project: true, proposal: true } });
          if (task) {
            const hash = await new PrivilegedGitService(this.prisma).commit(task.projectId, task.project.gitRoot, decided.id, `feat: ${task.proposal.title}`);
            await this.prisma.task.update({ where: { id: task.id }, data: { status: "COMMITTED" } });
            await ctx.reply(`Committed ${hash.slice(0, 12)}. No push has been made.`);
          }
        }
      } catch (error) { await ctx.answerCallbackQuery({ text: String(error), show_alert: true }); }
    });
  }

  private async resolve(value?: string) {
    if (!value) return null;
    const projects = await this.prisma.project.findMany();
    const needle = value.toLowerCase();
    return projects.find(p => p.slug.toLowerCase() === needle || p.name.toLowerCase() === needle) ?? null;
  }
  start() { return this.bot.start(); }
}
