import { z } from "zod";

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(item => asText(item)).filter(Boolean).map(item => `• ${item}`).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `• ${key}: ${asText(item)}`)
      .join("\n");
  }
  return value == null ? "" : String(value);
}

const field = z.unknown().transform(asText).transform(value => value || "Not specified");
const optionalField = z.unknown().optional().transform(value => {
  if (value == null) return undefined;
  const text = asText(value);
  return text || undefined;
});

export const proposalOutputSchema = z.object({
  title: field,
  summary: field,
  evidence: field,
  expected: field,
  problem: optionalField,
  solution: optionalField
});

export function parseProposalOutput(content: string) {
  return parseProposalList(content)[0]!;
}

export function parseProposalList(content: string) {
  const trimmed = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = Math.min(...["{", "["].map(char => { const i = trimmed.indexOf(char); return i < 0 ? Number.POSITIVE_INFINITY : i; }));
  if (!Number.isFinite(start)) throw new Error("Model did not return proposal JSON");
  const parsed = JSON.parse(start === trimmed.indexOf("[") ? trimmed.slice(trimmed.indexOf("["), trimmed.lastIndexOf("]") + 1) : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { recommendations?: unknown }).recommendations)
      ? (parsed as { recommendations: unknown[] }).recommendations
      : [parsed];
  return items.slice(0, 3).map(item => proposalOutputSchema.parse(item));
}

export const SUGGEST_PROMPT = `You are Archivist, a product-minded software teammate.

Propose 1 to 3 concrete improvements, ranked best first. Keep every field SHORT.

Rules:
- Distinct ideas, not the same idea rephrased.
- Do not default to TODO/FIXME comments.
- Prefer user experience: empty/error/loading states, clarity, recovery, accessibility.
- Fit the existing architecture. Do not invent metrics.
- Each of problem, solution, evidence, expected: at most 2 short bullets, max ~18 words each.
- evidence bullets should cite file paths you actually saw.

Return ONLY JSON:
{
  "recommendations": [
    {
      "title": "short action title, max 12 words",
      "problem": "bullet lines: the issue",
      "solution": "bullet lines: what to change",
      "summary": "same as solution",
      "evidence": "bullet lines with file paths",
      "expected": "bullet lines: what should feel better"
    }
  ]
}`;
