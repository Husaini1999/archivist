import fs from "node:fs/promises";
import path from "node:path";
import { redact, safeSlug } from "../security/redact.js";

const documents = ["profile", "architecture", "decisions", "priorities", "technical-debt"] as const;
const KINDS = "Problems|Recommendations|Changes|Outcome|Declined|Analysis|Recommendation|Decision|Implementation|Validation|Git|Learning";
const KIND_RE = new RegExp(`^## (${KINDS})\\s*$`, "m");
const ORDER = ["Implementation", "Changes", "Git", "Outcome", "Recommendation", "Problems", "Decision", "Declined", "Validation", "Learning", "Analysis"];
const LEGACY_BLOAT = /README excerpt:|Archivist memory:|Sampled source files/;

export type HistoryEvent = { kind: string; title: string; lines: string[] };
export type HistoryDay = { date: string; events: HistoryEvent[] };
export type DayLog = {
  problems: string[];
  recommendations: string[];
  changes: string[];
  outcome: string[];
  declined: string[];
};

function emptyLog(): DayLog {
  return { problems: [], recommendations: [], changes: [], outcome: [], declined: [] };
}

export class MemoryService {
  constructor(private readonly home: string) {}
  projectDir(slug: string) { return path.join(this.home, "memory", "projects", safeSlug(slug)); }

  async ensure(slug: string): Promise<string> {
    const dir = this.projectDir(slug);
    await fs.mkdir(path.join(dir, "history"), { recursive: true });
    await Promise.all(documents.map(async name => {
      const file = path.join(dir, `${name}.md`);
      try { await fs.access(file); } catch { await fs.writeFile(file, `# ${name.replace("-", " ")}\n\n`); }
    }));
    return dir;
  }

  async readRelevant(slug: string, names: string[] = ["profile", "architecture", "technical-debt", "priorities", "decisions"]) {
    const dir = await this.ensure(slug);
    const loaded = await Promise.all(names.filter(n => documents.includes(n as typeof documents[number])).map(async n => ({ name: n, content: await fs.readFile(path.join(dir, `${n}.md`), "utf8") })));
    return loaded.filter(item => item.content.replace(/^#.+$/m, "").trim().length > 40);
  }

  async write(slug: string, name: typeof documents[number], content: string) {
    await this.ensure(slug);
    await fs.writeFile(path.join(this.projectDir(slug), `${name}.md`), redact(content));
  }

  historyFile(slug: string, dateKey: string) {
    return path.join(this.projectDir(slug), "history", `${dateKey}.md`);
  }

  async readDay(slug: string, dateKey: string) {
    try { return await fs.readFile(this.historyFile(slug, dateKey), "utf8"); } catch { return ""; }
  }

  async appendHistory(slug: string, dateKey: string, section: "Analysis"|"Recommendation"|"Decision"|"Implementation"|"Validation"|"Git"|"Learning", content: string) {
    await this.ensure(slug);
    const file = this.historyFile(slug, dateKey);
    let existing = "";
    try { existing = await fs.readFile(file, "utf8"); } catch { existing = `# ${dateKey}\n`; }
    await fs.writeFile(file, `${existing}\n## ${section}\n\n${redact(content)}\n`);
    return file;
  }

  async upsertDay(slug: string, dateKey: string, patch: Partial<DayLog>) {
    await this.ensure(slug);
    const file = this.historyFile(slug, dateKey);
    let existing = "";
    try { existing = await fs.readFile(file, "utf8"); } catch { existing = ""; }
    if (existing && LEGACY_BLOAT.test(existing)) existing = compactDayMarkdown(dateKey, existing);
    const merged = mergeDayLog(existing ? parseDayLog(existing) : emptyLog(), patch);
    await fs.writeFile(file, redact(renderDayLog(dateKey, merged)));
    return file;
  }

  async listHistory(slug: string): Promise<HistoryDay[]> {
    const dir = path.join(this.projectDir(slug), "history");
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const files = names.filter(name => name.endsWith(".md")).sort().reverse().slice(0, 12);
    const days: HistoryDay[] = [];
    for (const name of files) {
      let text = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
      const date = name.replace(/\.md$/, "");
      if (LEGACY_BLOAT.test(text)) text = compactDayMarkdown(date, text);
      const events = parseHistoryEvents(text);
      if (events.length) days.push({ date, events });
    }
    return days;
  }
}

export function renderDayLog(date: string, log: DayLog) {
  const parts = [`# ${date}`];
  const addList = (title: string, items: string[]) => {
    if (!items.length) return;
    parts.push("", `## ${title}`, "");
    for (const item of items) parts.push(`- ${item}`);
  };
  addList("Problems", log.problems);
  if (log.recommendations.length) {
    parts.push("", "## Recommendations", "");
    log.recommendations.forEach((item, index) => {
      const [title, ...rest] = item.split("\n").map(line => line.trim()).filter(Boolean);
      parts.push(`${index + 1}. ${title}`);
      for (const line of rest) parts.push(`   ${line}`);
    });
  }
  addList("Changes", log.changes);
  addList("Outcome", log.outcome);
  addList("Declined", log.declined);
  return `${parts.join("\n")}\n`;
}

export function parseDayLog(text: string): DayLog {
  const log = emptyLog();
  const chunks = text.split(KIND_RE);
  for (let i = 1; i < chunks.length; i += 2) {
    const kind = chunks[i]!;
    const body = chunks[i + 1] ?? "";
    const bullets = body.split(/\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(line => line && !line.startsWith("#"));
    if (kind === "Problems") log.problems.push(...bullets);
    if (kind === "Changes") log.changes.push(...bullets);
    if (kind === "Outcome" || kind === "Git") log.outcome.push(...bullets);
    if (kind === "Declined" || kind === "Decision") log.declined.push(...bullets);
    if (kind === "Recommendations" || kind === "Recommendation") {
      const recs = splitNumbered(body);
      log.recommendations.push(...(recs.length ? recs : bullets.slice(0, 1)));
    }
  }
  return {
    problems: unique(log.problems),
    recommendations: uniqueByTitle(log.recommendations),
    changes: unique(log.changes),
    outcome: unique(log.outcome),
    declined: unique(log.declined)
  };
}

export function compactDayMarkdown(date: string, text: string) {
  return renderDayLog(date, dayLogFromLegacy(text));
}

function dayLogFromLegacy(text: string): DayLog {
  if (!LEGACY_BLOAT.test(text) && /^## (Problems|Recommendations|Changes|Outcome|Declined)\s*$/m.test(text)) return parseDayLog(text);
  const chunks = text.split(KIND_RE);
  const recRun: string[] = [];
  const problemRun: string[] = [];
  let lastRecs: string[] = [];
  let lastProblems: string[] = [];
  const changes: string[] = [];
  const outcome: string[] = [];
  const declined: string[] = [];
  const endRecRun = () => {
    if (recRun.length) {
      lastRecs = recRun.slice();
      lastProblems = problemRun.slice();
    }
    recRun.length = 0;
    problemRun.length = 0;
  };
  for (let i = 1; i < chunks.length; i += 2) {
    const kind = chunks[i]!;
    const body = chunks[i + 1] ?? "";
    if (kind === "Recommendation" || kind === "Recommendations") {
      const parsed = parseRecBlock(body);
      for (const rec of parsed) {
        recRun.push([rec.title, rec.problem && `Problem: ${rec.problem}`, rec.change && `Change: ${rec.change}`].filter(Boolean).join("\n"));
        if (rec.problem) problemRun.push(rec.problem);
      }
      continue;
    }
    endRecRun();
    if (kind === "Analysis") continue;
    if (kind === "Implementation" || kind === "Changes") changes.push(...implementationLines(body).filter(line => !/ ← | files  /.test(line) && !/^ai\//.test(line)));
    if (kind === "Git" || kind === "Outcome") outcome.push(...gitLines(body));
    if (kind === "Decision" || kind === "Declined") {
      const line = firstUsefulLine(body);
      if (line) declined.push(line);
    }
  }
  endRecRun();
  const impl = [...text.matchAll(/"branch":\s*"([^"]+)"/g)].pop()?.[1];
  const base = [...text.matchAll(/"base":\s*"([^"]+)"/g)].pop()?.[1];
  if (impl) outcome.unshift(`${impl}${base ? ` ← ${base}` : ""}`);
  return {
    problems: unique(lastProblems),
    recommendations: uniqueByTitle(lastRecs),
    changes: unique(changes),
    outcome: unique(outcome),
    declined: unique(declined)
  };
}

function mergeDayLog(base: DayLog, patch: Partial<DayLog>): DayLog {
  return {
    problems: unique([...(base.problems), ...(patch.problems ?? [])]),
    recommendations: uniqueByTitle([...(base.recommendations), ...(patch.recommendations ?? [])]),
    changes: unique([...(base.changes), ...(patch.changes ?? [])]),
    outcome: unique([...(base.outcome), ...(patch.outcome ?? [])]),
    declined: unique([...(base.declined), ...(patch.declined ?? [])])
  };
}

export function parseHistoryEvents(text: string): HistoryEvent[] {
  const source = LEGACY_BLOAT.test(text) ? compactDayMarkdown("day", text) : text;
  const chunks = source.split(KIND_RE);
  const events: HistoryEvent[] = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const kind = chunks[i]!;
    const body = chunks[i + 1] ?? "";
    if (kind === "Problems") events.push({ kind, title: "Problems", lines: bullets(body) });
    else if (kind === "Recommendations" || kind === "Recommendation") {
      const recs = splitNumbered(body);
      const lines = recs.length ? recs.map(item => item.split("\n")[0]!.trim()) : titlesFrom(body);
      if (lines.length) events.push({ kind: "Recommendation", title: "Recommendations", lines });
    } else if (kind === "Changes" || kind === "Implementation") {
      const lines = kind === "Changes" ? bullets(body) : implementationLines(body);
      if (lines.length) events.push({ kind: "Changes", title: "What changed", lines });
    } else if (kind === "Outcome" || kind === "Git") {
      const lines = kind === "Outcome" ? bullets(body) : gitLines(body);
      if (lines.length) events.push({ kind, title: "Outcome", lines });
    } else if (kind === "Declined" || kind === "Decision") {
      const line = firstUsefulLine(body) || bullets(body)[0];
      if (line) events.push({ kind: "Declined", title: "Declined", lines: [line] });
    } else if (kind === "Analysis") {
      events.push(summarizeAnalysis(body));
    }
  }
  return events.filter(event => event.lines.length).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || ORDER.indexOf(a.title) - ORDER.indexOf(b.title));
}

function parseRecBlock(body: string): { title: string; problem?: string; change?: string }[] {
  const numbered = splitNumbered(body);
  if (numbered.length > 1) {
    return numbered.map(block => {
      const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
      return {
        title: cleanTitle(lines[0] ?? ""),
        problem: capture(block, /Problem:\s*(.+)/i) || capture(block, /Evidence:\s*(.+)/i),
        change: capture(block, /Change:\s*(.+)/i)
      };
    }).filter(item => item.title);
  }
  const title = firstUsefulLine(body);
  if (!title) return [];
  return [{
    title,
    problem: capture(body, /Evidence:\s*(.+)/i) || capture(body, /Problem:\s*(.+)/i),
    change: body.split(/\n/).map(line => line.trim()).find(line => line && line !== title && !/^(evidence|problem|change):/i.test(line) && !line.startsWith("#"))
  }];
}

function splitNumbered(body: string) {
  const parts = body.split(/^\s*\d+\.\s+/m).map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1 && !/^\s*\d+\.\s+/m.test(body)) return [];
  return parts;
}

function bullets(body: string) {
  return unique(body.split(/\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(line => line && !line.startsWith("#") && !line.startsWith("{")));
}

function summarizeAnalysis(body: string): HistoryEvent {
  const tech = capture(body, /Technology:\s*([^\n.]+)/i);
  const branch = capture(body, /Branch:\s*([^\n.]+)/i);
  const tree = capture(body, /Working tree:\s*([^\n.]+)/i);
  const line = [tech, branch, tree].filter(Boolean).join(" · ") || "Sampled the repository";
  return { kind: "Analysis", title: "Analysis", lines: [line] };
}

function implementationLines(body: string): string[] {
  const parsed = extractJson(body) as { branch?: string; base?: string; files?: { file?: string; added?: number; deleted?: number }[]; changedFiles?: { file?: string; added?: number; deleted?: number }[] } | null;
  const files = (parsed?.files ?? parsed?.changedFiles ?? []).filter(file => file.file);
  const lines: string[] = [];
  if (parsed?.branch) lines.push(`${parsed.branch}${parsed.base ? ` ← ${parsed.base}` : ""}`);
  if (files.length) {
    for (const file of files.slice(0, 12)) lines.push(`${file.file}  +${file.added ?? 0} −${file.deleted ?? 0}`);
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
    if (files.length > 1) lines.push(`${files.length} files  +${added} −${deleted}`);
    return lines;
  }
  for (const line of body.split(/\n/)) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("\"")) continue;
    if (/^(time|accepted|files|stat|checks|tasks):/i.test(trimmed)) {
      if (/^(branch|stat):/i.test(trimmed)) lines.push(trimmed.replace(/^(branch|stat):\s*/i, ""));
      continue;
    }
    if (/\+\d+\s+[−-]\d+/.test(trimmed) || /^[\w./-]+\.[A-Za-z]{1,8}\b/.test(trimmed) || / ← | from | files,/.test(trimmed)) {
      lines.push(trimmed.replace(/^branch:\s*/i, ""));
    }
    if (lines.length >= 14) break;
  }
  return lines.length ? unique(lines).slice(0, 14) : ["Changes were applied on an AI branch"];
}

function gitLines(body: string): string[] {
  const lines: string[] = [];
  for (const line of body.split(/\n/).map(part => part.trim().replace(/^[-*]\s*/, "")).filter(Boolean)) {
    if (/^accepted:/i.test(line) || /^time:/i.test(line)) continue;
    lines.push(line.replace(/^branch:\s*/i, "").replace(/^pull request:\s*/i, ""));
    if (lines.length >= 6) break;
  }
  return unique(lines);
}

function titlesFrom(body: string): string[] {
  const numbered = splitNumbered(body).map(block => cleanTitle(block.split("\n")[0] ?? "")).filter(Boolean);
  if (numbered.length) return numbered;
  const first = firstUsefulLine(body);
  return first ? [first] : [];
}

function firstUsefulLine(body: string): string | undefined {
  for (const line of body.split(/\n/).map(part => part.trim().replace(/^[-*•]\s*/, ""))) {
    if (!line || line.startsWith("{") || line.startsWith("#")) continue;
    if (/^(evidence|time|project|technology|branch|working tree|archivist memory|top-level|package\.json|readme|sampled source|accepted|files|stat|checks|tasks|problem|change):/i.test(line)) continue;
    if (line.length > 160) continue;
    return cleanTitle(line);
  }
}

function cleanTitle(text: string) {
  return text.replace(/\s+/g, " ").replace(/\.$/, "").trim();
}

function capture(text: string, pattern: RegExp) {
  return text.match(pattern)?.[1]?.trim();
}

function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function unique(items: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniqueByTitle(items: string[]) {
  const map = new Map<string, string>();
  for (const item of items) {
    const title = (item.split("\n")[0] ?? "").toLowerCase();
    if (!title) continue;
    map.set(title, item);
  }
  return [...map.values()];
}
