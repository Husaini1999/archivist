import crypto from "node:crypto";
import cron from "node-cron";
import type { PrismaClient } from "@prisma/client";
import type { ArchivistOrchestrator } from "../orchestrator/archivist.js";
import { dateKey } from "../orchestrator/archivist.js";
import { DAILY_HOUR } from "../scheduler/clock.js";

export interface RecommendationSender {
  sendProposal(projectName: string, proposal: { id: string; title: string; summary: string; evidence: string; expected: string }, token: string): Promise<string | undefined>
  sendProposals?(projectName: string, items: { proposal: { id: string; title: string; summary: string; evidence: string; expected: string }; token: string }[]): Promise<string | undefined>
}

export class DailyScheduler {
  constructor(private readonly prisma: PrismaClient, private readonly orchestrator: ArchivistOrchestrator, private readonly sender: RecommendationSender, private readonly timezone: string) {}

  async run(now = new Date()) {
    const settings = await this.prisma.scheduleSettings.upsert({ where: { id: 1 }, create: { id: 1, timezone: this.timezone }, update: {} });
    if (settings.globalPaused) return { processed: 0, skipped: "global-paused" };
    const projects = await this.prisma.project.findMany({ where: { autoImproveEnabled: true, paused: false } });
    let processed = 0;
    for (const project of projects) {
      const key = dateKey(now, settings.timezone);
      try { await this.prisma.dailyRun.create({ data: { projectId: project.id, dateKey: key, status: "RUNNING" } }); }
      catch { continue; }
      try {
        const proposals = await this.orchestrator.suggest(project);
        const items = [];
        for (const proposal of proposals) {
          const approval = await this.prisma.approval.create({ data: { type: "PROPOSAL", projectId: project.id, proposalId: proposal.id, callbackToken: crypto.randomUUID().replaceAll("-", "").slice(0, 24), expiresAt: new Date(Date.now() + 48 * 3_600_000) } });
          items.push({ proposal, token: approval.callbackToken });
        }
        const messageId = this.sender.sendProposals
          ? await this.sender.sendProposals(project.name, items)
          : await this.sender.sendProposal(project.name, items[0]!.proposal, items[0]!.token);
        await this.prisma.dailyRun.update({ where: { projectId_dateKey: { projectId: project.id, dateKey: key } }, data: { status: "SENT", telegramMessageId: messageId } });
        processed++;
      } catch (error) {
        await this.prisma.dailyRun.update({ where: { projectId_dateKey: { projectId: project.id, dateKey: key } }, data: { status: "FAILED", error: String(error) } });
      }
    }
    return { processed };
  }

  start(hour = DAILY_HOUR, minute = 0) {
    return cron.schedule(`${minute} ${hour} * * *`, () => { void this.run(); }, { timezone: this.timezone });
  }
}
