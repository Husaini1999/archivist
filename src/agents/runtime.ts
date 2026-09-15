import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LLMProvider, ChatMessage, ToolSpec } from "../integrations/llm.js";
import type { ToolRegistry } from "../tools/registry.js";
import { throwIfAborted } from "../cancel.js";

export const roles = ["lead", "product", "ux", "frontend", "backend", "qa", "reviewer"] as const;
export type AgentRole = typeof roles[number];
const outputSchema = z.object({ summary: z.string(), completed: z.boolean(), findings: z.array(z.string()).default([]) });

export const ROLE_TOOLS: Record<AgentRole, string[]> = {
  lead: ["listFiles", "readFile", "searchCode", "getGitStatus"],
  product: ["listFiles", "readFile", "searchCode"],
  ux: ["listFiles", "readFile", "searchCode"],
  frontend: ["listFiles", "readFile", "searchCode", "editFile", "writeFile", "createFile", "getGitStatus", "getGitDiff"],
  backend: ["listFiles", "readFile", "searchCode", "editFile", "writeFile", "createFile", "getGitStatus", "getGitDiff"],
  qa: ["listFiles", "readFile", "searchCode", "getGitDiff"],
  reviewer: ["listFiles", "readFile", "getGitStatus", "getGitDiff"]
};

export function truncateToolOutput(value: unknown, max = 4_000): string {
  if (value == null) return "ok";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return "ok";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export function compactMessages(messages: ChatMessage[], keepToolTurns = 3): ChatMessage[] {
  const toolIndexes = messages.map((message, index) => message.role === "tool" ? index : -1).filter(index => index >= 0);
  const drop = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepToolTurns)));
  return messages.map((message, index) => {
    if (!drop.has(index) || message.role !== "tool") return message;
    return { ...message, content: "[older tool output omitted to save tokens]" };
  });
}

function parseAgentJson(content: string) {
  const trimmed = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model did not return JSON");
  return outputSchema.parse(JSON.parse(trimmed.slice(start, end + 1)));
}

export function iterationBudget(taskCount: number) {
  return Math.min(28, 12 + Math.max(1, taskCount) * 6);
}

export function runTimeoutMs(taskCount: number) {
  return Math.min(12 * 60_000, 240_000 + Math.max(1, taskCount) * 120_000);
}

export class AgentRuntime {
  constructor(private readonly llm: LLMProvider, private readonly tools: ToolRegistry, private readonly promptRoot: string, private readonly maxIterations = 8, private readonly timeoutMs = 180_000) {}
  async run(role: AgentRole, request: string, signal?: AbortSignal) {
    const prompt = await fs.readFile(path.join(this.promptRoot, `${role}.md`), "utf8");
    const messages: ChatMessage[] = [{ role: "system", content: `${prompt}\n\nMinimize tokens. Read only files you will edit. Prefer editFile over rewriting a whole file. Smallest possible diff. Do not run tests. Stop calling tools and return JSON as soon as the edits are done.` }, { role: "user", content: request }];
    const specs = this.toolSpecs(role);
    const operation = async () => {
      for (let i = 0; i < this.maxIterations; i++) {
        throwIfAborted(signal);
        const result = await this.llm.chat(compactMessages(messages, 5), specs, signal);
        throwIfAborted(signal);
        if (!result.toolCall) return parseAgentJson(result.content);
        const tool = this.tools[result.toolCall.name];
        if (!tool) throw new Error(`Tool not allowed: ${result.toolCall.name}`);
        let output: unknown;
        try { output = await tool(result.toolCall.arguments); }
        catch (error) { output = { error: error instanceof Error ? error.message : String(error) }; }
        throwIfAborted(signal);
        const callId = result.toolCall.id || `call_${i}`;
        messages.push(
          {
            role: "assistant",
            content: result.content || "",
            tool_calls: [{ id: callId, type: "function", function: { name: result.toolCall.name, arguments: JSON.stringify(result.toolCall.arguments ?? {}) } }]
          },
          { role: "tool", tool_call_id: callId, content: truncateToolOutput(output) }
        );
      }
      messages.push({ role: "user", content: "No more tools. Return ONLY JSON: {\"summary\":\"what you changed\",\"completed\":true,\"findings\":[]}" });
      const wrap = await this.llm.chat(compactMessages(messages, 5), [], signal);
      try {
        return parseAgentJson(wrap.content);
      } catch {
        return { summary: "Reached the tool-call budget. Review the uncommitted diff.", completed: true, findings: ["Stopped after the iteration cap"] };
      }
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Agent timed out")), this.timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      operation().then(value => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      }, error => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  private toolSpecs(role: AgentRole): ToolSpec[] {
    const preferred = (ROLE_TOOLS[role] ?? []).filter(name => name in this.tools);
    const names = preferred.length ? preferred : Object.keys(this.tools);
    return names.map(name => ({
      name,
      description: `Archivist ${name} tool`,
      inputSchema: { type: "object", properties: { path: { type: "string" }, query: { type: "string" }, content: { type: "string" }, old: { type: "string" }, replacement: { type: "string" } } }
    }));
  }
}
