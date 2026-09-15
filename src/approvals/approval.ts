import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const transitions = {
  proposal: { PENDING: ["APPROVED", "REJECTED"], APPROVED: [], REJECTED: [] },
  task: { APPROVED: ["RUNNING"], RUNNING: ["AWAITING_COMMIT", "FAILED"], AWAITING_COMMIT: ["COMMITTED", "DECLINED"], COMMITTED: [], DECLINED: [], FAILED: [] }
} as const;

export class ApprovalService {
  constructor(private readonly prisma: PrismaClient, private readonly allowedUsers: Set<string>, private readonly ttlHours = 48) {}

  async create(data: { type: "PROPOSAL"|"COMMIT"|"PUSH"|"MEMORY_COMMIT"|"MEMORY_PUSH"; projectId: string; proposalId?: string; taskId?: string }) {
    return this.prisma.approval.create({ data: {
      ...data, callbackToken: crypto.randomBytes(12).toString("base64url"),
      expiresAt: new Date(Date.now() + this.ttlHours * 3_600_000)
    } });
  }

  async decide(token: string, userId: string, decision: "APPROVED"|"REJECTED") {
    const approval = await this.prisma.approval.findUnique({ where: { callbackToken: token } });
    if (!this.allowedUsers.has(userId)) {
      await this.audit("approval.unauthorized", userId, approval?.projectId, token);
      throw new Error("Unauthorized Telegram user");
    }
    if (!approval || approval.status !== "PENDING") throw new Error("Approval is missing or already decided");
    if (approval.expiresAt <= new Date()) {
      await this.prisma.approval.update({ where: { id: approval.id }, data: { status: "EXPIRED" } });
      throw new Error("Approval expired");
    }
    const updated = await this.prisma.$transaction(async tx => {
      const value = await tx.approval.update({ where: { id: approval.id }, data: { status: decision, telegramUserId: userId, decidedAt: new Date() } });
      if (approval.type === "PROPOSAL" && approval.proposalId) {
        await tx.proposal.update({ where: { id: approval.proposalId }, data: { status: decision } });
        if (decision === "APPROVED") await tx.task.create({ data: { projectId: approval.projectId, proposalId: approval.proposalId, status: "APPROVED" } });
      }
      return value;
    });
    await this.audit(`approval.${decision.toLowerCase()}`, userId, approval.projectId, approval.id);
    return updated;
  }

  private audit(action: string, actor: string, projectId: string | undefined, details: string) {
    return this.prisma.auditLog.create({ data: { action, actor, projectId, details } });
  }
}
