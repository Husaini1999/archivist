import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LLMProvider, ChatMessage } from "../integrations/llm.js";
import type { ToolRegistry } from "../tools/registry.js";

export const roles = ["lead", "product", "ux", "frontend", "backend", "qa", "reviewer"] as const;
export type AgentRole = typeof roles[number];
const outputSchema = z.object({ summary: z.string(), completed: z.boolean(), findings: z.array(z.string()).default([]) });

export class AgentRuntime {
  constructor(private readonly llm: LLMProvider, private readonly tools: ToolRegistry, private readonly promptRoot: string, private readonly maxIterations = 12, private readonly timeoutMs = 180_000) {}
  async run(role: AgentRole, request: string) {
    const prompt = await fs.readFile(path.join(this.promptRoot, `${role}.md`), "utf8");
    const messages: ChatMessage[] = [{ role: "system", content: prompt }, { role: "user", content: request }];
    const operation = async () => {
      for (let i = 0; i < this.maxIterations; i++) {
        const result = await this.llm.chat(messages, Object.keys(this.tools).map(name => ({ name, description: `Archivist ${name} tool`, inputSchema: { type: "object", additionalProperties: true } })));
        if (!result.toolCall) return outputSchema.parse(JSON.parse(result.content));
        const tool = this.tools[result.toolCall.name];
        if (!tool) throw new Error(`Tool not allowed: ${result.toolCall.name}`);
        let output: unknown;
        try { output = await tool(result.toolCall.arguments); }
        catch (error) { output = { error: error instanceof Error ? error.message : String(error) }; }
        messages.push({ role: "assistant", content: result.content || `Calling ${result.toolCall.name}` }, { role: "tool", name: result.toolCall.name, content: JSON.stringify(output) });
      }
      throw new Error("Agent iteration limit exceeded");
    };
    return Promise.race([operation(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Agent timed out")), this.timeoutMs))]);
  }
}
