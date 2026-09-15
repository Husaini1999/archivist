export const DAILY_HOUR = 8;
export const DAILY_MINUTE = 0;

export type ListedProject = { slug: string; paused?: boolean; autoImproveEnabled?: boolean };

export function zoneCity(timezone: string) {
  return timezone.split("/").pop()?.replaceAll("_", " ") ?? timezone;
}

export function utcOffsetLabel(timezone: string, date = new Date()) {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find(part => part.type === "timeZoneName")?.value ?? "";
    return name.replace(/^GMT/, "UTC") || "UTC+8";
  } catch {
    return "UTC+8";
  }
}

export function dailyTimeLabel(timezone: string, hour = DAILY_HOUR) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 || 12;
  return `${twelve}:00 ${suffix}`;
}

export function dailyScheduleLine(timezone: string, hour = DAILY_HOUR) {
  return `${dailyTimeLabel(timezone, hour)} ${zoneCity(timezone)} (${timezone}, ${utcOffsetLabel(timezone)})`;
}

export function groupProjects(projects: ListedProject[]) {
  return {
    enabled: projects.filter(project => project.autoImproveEnabled && !project.paused),
    off: projects.filter(project => !project.autoImproveEnabled && !project.paused),
    paused: projects.filter(project => project.paused)
  };
}

export function formatDaemonBanner(projects: ListedProject[], timezone: string, hour = DAILY_HOUR) {
  const { enabled, off, paused } = groupProjects(projects);
  const lines = [
    "🤖  Archivist daemon is running",
    "",
    "📅  Daily agent recommendations",
    `    ${dailyScheduleLine(timezone, hour)}`,
    "    Enabled projects get recs in Telegram at this time.",
    ""
  ];
  const add = (title: string, slugs: ListedProject[]) => {
    if (!slugs.length) return;
    lines.push(title);
    for (const project of slugs) lines.push(`    - ${project.slug}`);
    lines.push("");
  };
  if (enabled.length) add("✅  Enabled", enabled);
  else {
    lines.push("⚪  No projects enabled yet");
    lines.push("    Enable one in Telegram: /enable {project}");
    lines.push("");
  }
  add("⚪  Off", off);
  add("⏸  Paused", paused);
  lines.push("📡  Telegram is polling. Keep this window open.");
  return lines.join("\n");
}
