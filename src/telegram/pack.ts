import { InlineKeyboard } from "grammy";

export type RecDecision = "pending" | "accepted" | "declined";

export type RecPackItem = {
  proposal: { id: string; title: string; summary: string; evidence: string; expected: string; problem?: string; solution?: string };
  token: string;
  decision: RecDecision;
};

export type RecPack = {
  id: string;
  projectName: string;
  items: RecPackItem[];
};

export function allDecided(pack: RecPack) {
  return pack.items.length > 0 && pack.items.every(item => item.decision !== "pending");
}

export function parsePackCallback(data: string): { kind: "accept" | "decline" | "apply"; packId: string; index?: number } | null {
  const apply = /^g:([A-Za-z0-9_-]+)$/.exec(data);
  if (apply) return { kind: "apply", packId: apply[1]! };
  const pick = /^([sr]):([A-Za-z0-9_-]+):(\d+)$/.exec(data);
  if (!pick) return null;
  return { kind: pick[1] === "s" ? "accept" : "decline", packId: pick[2]!, index: Number(pick[3]) };
}

export function buildPackKeyboard(pack: RecPack) {
  const keyboard = new InlineKeyboard();
  for (const [index, item] of pack.items.entries()) {
    const n = index + 1;
    const accept = item.decision === "accepted" ? `✅ ${n} ✓` : `✅ ${n}`;
    const decline = item.decision === "declined" ? `❌ ${n} ✓` : `❌ ${n}`;
    keyboard.text(accept, `s:${pack.id}:${index}`).text(decline, `r:${pack.id}:${index}`).row();
  }
  if (allDecided(pack)) keyboard.text("▶️ Apply", `g:${pack.id}`);
  return keyboard;
}

export function setPackDecision(pack: RecPack, index: number, decision: Exclude<RecDecision, "pending">) {
  const item = pack.items[index];
  if (!item) return pack;
  item.decision = decision;
  return pack;
}
