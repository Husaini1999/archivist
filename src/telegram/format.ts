export function toBullets(text: string, maxItems = 3, maxChars = 140): string[] {
  const raw = String(text ?? "").replace(/\r/g, "").trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  const items = lines.length > 1 ? lines : raw.split(/(?<=\.)\s+(?=[A-Z])/).map(part => part.trim()).filter(Boolean);
  return items.slice(0, maxItems).map(item => (item.length > maxChars ? `${item.slice(0, maxChars - 1).trimEnd()}…` : item));
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function section(title: string, text: string, numbered = false) {
  const items = toBullets(text);
  if (!items.length) return "";
  const body = items.map((item, index) => `${numbered ? `${index + 1}.` : "•"} ${escapeHtml(item)}`).join("\n");
  return `<b>${escapeHtml(title)}</b>\n${body}`;
}

export function formatProposalMessage(projectName: string, p: { title: string; summary: string; evidence: string; expected: string; problem?: string; solution?: string }) {
  const problem = p.problem || p.evidence;
  const solution = p.solution || p.summary;
  const parts = [
    `🌅 <b>${escapeHtml(projectName)}</b>`,
    `<b>${escapeHtml(p.title)}</b>`,
    section("Problem", problem),
    section("Solution", solution),
    p.problem ? section("Evidence", p.evidence) : "",
    section("Expected", p.expected)
  ].filter(Boolean);
  return `${parts.join("\n\n")}\n\n<i>Estimates only. Tap Details for the full write-up.</i>`;
}

function recStatus(decision?: "pending" | "accepted" | "declined") {
  if (decision === "accepted") return "Status: ✅ accept";
  if (decision === "declined") return "Status: ❌ decline";
  return "Status: ⏳ waiting";
}

export function formatProposalList(
  projectName: string,
  proposals: { title: string; summary: string; evidence: string; expected: string; problem?: string; solution?: string }[],
  decisions?: Array<"pending" | "accepted" | "declined">
) {
  if (proposals.length <= 1) return formatProposalMessage(projectName, proposals[0] ?? { title: "No recommendation", summary: "", evidence: "", expected: "" });
  const blocks = proposals.map((proposal, index) => {
    const problem = proposal.problem || proposal.evidence;
    const solution = proposal.solution || proposal.summary;
    return [
      `<b>${index + 1}. ${escapeHtml(proposal.title)}</b>`,
      `<i>${recStatus(decisions?.[index])}</i>`,
      section("Problem", problem),
      section("Solution", solution),
      section("Expected", proposal.expected)
    ].filter(Boolean).join("\n\n");
  });
  const waiting = proposals.some((_, index) => (decisions?.[index] ?? "pending") === "pending");
  const footer = waiting
    ? "Mark every item ✅ or ❌. Apply appears after all are chosen. Nothing starts until Apply."
    : "All items decided. Tap Apply to start accepted work (or record declines).";
  return `🌅 <b>${escapeHtml(projectName)}</b>\n\n${blocks.join("\n\n")}\n\n<i>${footer}</i>`;
}

export function formatImplementationReport(projectName: string, report: {
  branch?: string;
  base?: string;
  summary?: string;
  files?: { file: string; added: number; deleted: number }[];
  added?: number;
  deleted?: number;
  checks?: { name: string; status: string; excerpt?: string }[];
  testsPassed?: boolean;
  tested?: boolean;
  notice?: string;
}) {
  const files = report.files ?? [];
  const base = report.base || "main";
  const checkLine = (report.checks ?? []).map(check => {
    if (check.status === "passed") return `✅ ${escapeHtml(check.name)}`;
    if (check.status === "failed") {
      const why = check.excerpt?.trim().split(/\n/)[0]?.slice(0, 120);
      return `❌ ${escapeHtml(check.name)}${why ? `\n<i>${escapeHtml(why)}</i>` : ""}`;
    }
    const why = (check.excerpt || "not run").trim().replace(/\.$/, "");
    return `⚪ ${escapeHtml(check.name)} — skipped (${escapeHtml(why)})`;
  }).join("\n") || "⚪ No checks ran";
  const fileLines = files.slice(0, 20).map(file => `• <code>${escapeHtml(file.file)}</code>  <b>+${file.added}</b> −${file.deleted}`).join("\n") || "• No file changes";
  const blocked = report.tested && report.testsPassed === false;
  const warning = blocked
    ? "Commit is blocked until tests pass. Nothing was pushed. Production was not changed."
    : `⚠️ WARNING: One approval commits all accepted work on this AI branch, pushes it, and opens a single pull request into ${base} (often production). It does NOT merge, deploy, or update ${base}. ${base} stays unchanged until you merge the PR on GitHub.`;
  return [
    `🛠 <b>${escapeHtml(projectName)}</b>`,
    `<b>Branch</b>\n<code>${escapeHtml(report.branch || "unknown")}</code> ← from <code>${escapeHtml(base)}</code>\n<i>Local only until you approve. GitHub cannot show an uncommitted or unpushed diff.</i>`,
    `<b>What changed</b>\n${toBullets(report.summary || "").map(item => `• ${escapeHtml(item)}`).join("\n") || "• See file list."}`,
    `<b>Tests</b>\n${checkLine}`,
    `<b>Diff</b>\n${fileLines}\n<b>+${report.added ?? 0}</b> −${report.deleted ?? 0}`,
    `<b>If you approve</b>\n${escapeHtml(warning)}`
  ].join("\n\n");
}

export function formatFileDiff(file: string, added: number, deleted: number, patch: string) {
  const clipped = patch.length > 3500 ? `${patch.slice(0, 3500)}\n… truncated` : patch;
  return `📄 <code>${escapeHtml(file)}</code>  <b>+${added}</b> −${deleted}\n\n<pre>${escapeHtml(clipped) || "(no textual diff)"}</pre>`;
}

export function formatProposalDetails(p: { title: string; summary: string; evidence: string; expected: string; problem?: string; solution?: string }) {
  const parts = [
    `<b>${escapeHtml(p.title)}</b>`,
    section("Problem", p.problem || p.evidence),
    section("Solution", p.solution || p.summary),
    section("Expected", p.expected)
  ].filter(Boolean);
  return parts.join("\n\n");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatHistoryDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function formatProjectHistory(slug: string, days: { date: string; events: { title: string; lines: string[] }[] }[]) {
  if (!days.length) {
    return [
      `📁 <b>${escapeHtml(slug)}</b>`,
      "",
      "No history yet.",
      "After /now, Apply, and opening a PR, a short list of changes shows up here."
    ].join("\n");
  }
  const blocks = [`📁 <b>${escapeHtml(slug)}</b>`];
  for (const day of days.slice(0, 8)) {
    blocks.push(`\n<b>${escapeHtml(formatHistoryDate(day.date))}</b>`);
    for (const event of day.events) {
      blocks.push(`\n<b>${escapeHtml(event.title)}</b>`);
      for (const line of event.lines.slice(0, 12)) blocks.push(`    ${escapeHtml(line)}`);
    }
  }
  return blocks.join("\n");
}
