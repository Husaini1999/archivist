export function commitSubject(titles: string[]): string {
  const parts = titles
    .map(title => title.replace(/^(feat|fix|chore|docs|refactor):\s*/i, "").replace(/\s+/g, " ").replace(/\.$/, "").trim())
    .filter(Boolean)
    .map(title => title.charAt(0).toLowerCase() + title.slice(1));
  if (!parts.length) return "improve error handling and empty states";
  if (parts.length === 1) return clip(parts[0]!);
  const joined = parts.length === 2
    ? `${parts[0]} and ${parts[1]}`
    : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  if (joined.length <= 140) return joined;
  return clip(`${parts[0]} and related fixes`);
}

export function commitMessage(titles: string[]): string {
  return `feat: ${commitSubject(titles)}`;
}

function clip(text: string, max = 90) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
