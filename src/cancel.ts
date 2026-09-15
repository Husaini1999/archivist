export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error("Cancelled");
    error.name = "AbortError";
    throw error;
  }
}

export function isCancelled(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /cancelled/i.test(error.message));
}
