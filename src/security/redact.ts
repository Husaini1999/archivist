const secretPatterns = [
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']+/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g
];

export function redact(value: string): string {
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

export function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "project";
}
