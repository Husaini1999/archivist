import { z } from "zod";

export interface ChatMessage { role: "system"|"user"|"assistant"|"tool"; content: string; name?: string }
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface LLMProvider { chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<{ content: string; toolCall?: { name: string; arguments: Record<string, unknown> } }> }

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly model: string) {}
  async chat(messages: ChatMessage[], tools: ToolSpec[] = []) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) })
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const json = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable(), tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }) })).min(1) }).parse(await response.json());
    const msg = json.choices[0]!.message, call = msg.tool_calls?.[0]?.function;
    return { content: msg.content ?? "", toolCall: call ? { name: call.name, arguments: JSON.parse(call.arguments) as Record<string, unknown> } : undefined };
  }
}

export class MockLLMProvider implements LLMProvider {
  constructor(private readonly responses: { content: string; toolCall?: { name: string; arguments: Record<string, unknown> } }[]) {}
  async chat() { const value = this.responses.shift(); if (!value) throw new Error("Mock responses exhausted"); return value; }
}
