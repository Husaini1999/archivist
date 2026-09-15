import { z } from "zod";
import { estimateTokens, isRateLimitError, parseRetryAfterSeconds, sleep, TokenBudget } from "./rateLimit.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ChatResult {
  content: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  usage?: { totalTokens: number };
}
export interface LLMProvider {
  chat(messages: ChatMessage[], tools?: ToolSpec[], signal?: AbortSignal): Promise<ChatResult>;
  onWait?: (seconds: number) => void;
}

export function formatLlmHttpError(status: number, body: string) {
  let detail = body.replace(/\s+/g, " ").trim().slice(0, 400);
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof json.error === "object" && json.error?.message != null
      ? json.error.message
      : json.error ?? json.message;
    if (typeof message === "string" && message.trim()) detail = message.trim().slice(0, 400);
    else if (message && typeof message !== "string") detail = JSON.stringify(message).slice(0, 400);
  } catch {
    /* keep raw body */
  }
  return `LLM HTTP ${status}: ${detail || "request rejected"}`;
}

export function textContent(value: string | null | undefined) {
  return typeof value === "string" ? value : "";
}

export function toApiMessage(message: ChatMessage) {
  const content = textContent(message.content);
  if (message.role === "tool") {
    return { role: "tool" as const, tool_call_id: message.tool_call_id || "call_0", content };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return { role: "assistant" as const, content, tool_calls: message.tool_calls };
  }
  return { role: message.role, content };
}

export function buildChatBody(model: string, messages: ChatMessage[], tools: ToolSpec[] = [], maxTokens = 2048) {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: messages.map(toApiMessage)
  };
  if (tools.length) {
    body.tools = tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
          additionalProperties: true
        }
      }
    }));
    body.tool_choice = "auto";
  }
  return body;
}

export class OpenAICompatibleProvider implements LLMProvider {
  onWait?: (seconds: number) => void;
  readonly budget: TokenBudget;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly model: string, tpmLimit = 200_000) {
    this.budget = new TokenBudget(tpmLimit);
  }
  async chat(messages: ChatMessage[], tools: ToolSpec[] = [], signal?: AbortSignal) {
    if (!this.model.trim()) throw new Error("LLM_MODEL is empty. Set it in .env and restart the daemon.");
    const body = buildChatBody(this.model, messages, tools);
    const estimated = estimateTokens(JSON.stringify(body)) + 256;
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.budget.waitFor(estimated, signal, seconds => this.onWait?.(seconds));
      try {
        const result = await this.request(body, signal);
        this.budget.record(result.usage?.totalTokens || estimated);
        return result;
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error) || attempt === 5) throw error;
        const seconds = parseRetryAfterSeconds(String(error)) ?? Math.min(20, 2 ** attempt);
        this.onWait?.(seconds);
        await sleep(seconds * 1000, signal);
      }
    }
    throw lastError;
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResult> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      signal,
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(formatLlmHttpError(response.status, await response.text().catch(() => "")));
    const json = z.object({
      usage: z.object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional()
      }).optional(),
      choices: z.array(z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(z.object({
            id: z.string().optional(),
            function: z.object({ name: z.string(), arguments: z.string() })
          })).optional()
        })
      })).min(1)
    }).parse(await response.json());
    const msg = json.choices[0]!.message;
    const call = msg.tool_calls?.[0];
    let args: Record<string, unknown> = {};
    if (call) {
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
      catch { args = { raw: call.function.arguments }; }
    }
    const totalTokens = json.usage?.total_tokens
      ?? ((json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0));
    return {
      content: msg.content ?? "",
      toolCall: call ? { id: call.id || "call_0", name: call.function.name, arguments: args } : undefined,
      usage: totalTokens ? { totalTokens } : undefined
    };
  }
}

export class MockLLMProvider implements LLMProvider {
  onWait?: (seconds: number) => void;
  constructor(private readonly responses: { content: string; toolCall?: { id?: string; name: string; arguments: Record<string, unknown> } }[]) {}
  async chat() {
    const value = this.responses.shift();
    if (!value) throw new Error("Mock responses exhausted");
    return {
      content: value.content,
      toolCall: value.toolCall ? { id: value.toolCall.id || "call_0", ...value.toolCall } : undefined
    };
  }
}
