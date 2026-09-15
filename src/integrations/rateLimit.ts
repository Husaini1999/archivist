import { throwIfAborted } from "../cancel.js";

export function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(String(text ?? "").length / 4));
}

export function parseRetryAfterSeconds(text: string): number | undefined {
  const match = /try again in ([\d.]+)\s*s/i.exec(text);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.min(90, Math.max(1, Math.ceil(seconds))) : undefined;
}

export function isRateLimitError(error: unknown) {
  return error instanceof Error && (/LLM HTTP 429/i.test(error.message) || /rate limit/i.test(error.message));
}

export async function sleep(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TokenBudget {
  private events: { tokens: number; at: number }[] = [];
  constructor(
    readonly limitPerMinute: number,
    private readonly headroom = 0.75,
    private readonly clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> } = { now: () => Date.now(), sleep }
  ) {}

  used(): number {
    const cutoff = this.clock.now() - 60_000;
    this.events = this.events.filter(event => event.at > cutoff);
    return this.events.reduce((sum, event) => sum + event.tokens, 0);
  }

  cap() {
    return Math.max(1, Math.floor(this.limitPerMinute * this.headroom));
  }

  record(tokens: number) {
    if (tokens > 0) this.events.push({ tokens, at: this.clock.now() });
  }

  async waitFor(tokens: number, signal?: AbortSignal, onWait?: (seconds: number) => void) {
    const need = Math.max(0, tokens);
    if (need >= this.cap()) return;
    while (this.used() + need > this.cap()) {
      throwIfAborted(signal);
      const oldest = this.events[0];
      const waitMs = oldest ? Math.max(500, oldest.at + 60_000 - this.clock.now() + 250) : 1000;
      onWait?.(Math.ceil(waitMs / 1000));
      await this.clock.sleep(Math.min(waitMs, 20_000), signal);
    }
  }
}
