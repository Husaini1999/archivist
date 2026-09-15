import { describe, expect, it, vi } from "vitest";
import { ApprovalService } from "../src/approvals/approval.js";

function fake(overrides: Record<string, unknown> = {}) {
  const approval = { id: "a1", projectId: "p1", proposalId: "x1", taskId: null, type: "PROPOSAL", callbackToken: "token", status: "PENDING", expiresAt: new Date(Date.now() + 60_000), ...overrides };
  const tx = {
    approval: { update: vi.fn(async ({ data }) => ({ ...approval, ...data })) },
    proposal: { update: vi.fn() },
    task: { create: vi.fn() }
  };
  const prisma = {
    approval: { findUnique: vi.fn().mockResolvedValue(approval), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx))
  };
  return { prisma, tx };
}

describe("approval validation", () => {
  it("approves a proposal and creates a task", async () => {
    const { prisma, tx } = fake();
    const result = await new ApprovalService(prisma as never, new Set(["42"])).decide("token", "42", "APPROVED");
    expect(result.status).toBe("APPROVED");
    expect(tx.task.create).toHaveBeenCalledOnce();
  });
  it("declines without creating a task", async () => {
    const { prisma, tx } = fake();
    await new ApprovalService(prisma as never, new Set(["42"])).decide("token", "42", "REJECTED");
    expect(tx.task.create).not.toHaveBeenCalled();
  });
  it("denies unauthorized users", async () => {
    const { prisma } = fake();
    await expect(new ApprovalService(prisma as never, new Set(["42"])).decide("token", "99", "APPROVED")).rejects.toThrow("Unauthorized");
  });
  it("expires stale approvals", async () => {
    const { prisma } = fake({ expiresAt: new Date(0) });
    await expect(new ApprovalService(prisma as never, new Set(["42"])).decide("token", "42", "APPROVED")).rejects.toThrow("expired");
    expect(prisma.approval.update).toHaveBeenCalled();
  });
});
