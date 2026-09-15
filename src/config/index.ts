import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  ARCHIVIST_TIMEZONE: z.string().default("Asia/Kuala_Lumpur"),
  ARCHIVIST_PROJECT_ROOTS: z.string().default(""),
  ARCHIVIST_HOME: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  LLM_PROVIDER: z.string().default("openai-compatible"),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().optional(),
  APPROVAL_TTL_HOURS: z.coerce.number().positive().default(48),
  SCHEDULER_CATCH_UP: z.string().default("true")
});

/** Walk up from a file location until package.json name is "archivist". */
export function findSoftwareRoot(startDir: string = here): string {
  let current = path.resolve(startDir);
  while (true) {
    const pkgPath = path.join(current, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === "archivist") return current;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the Archivist software root (package.json name \"archivist\"). Set ARCHIVIST_HOME.");
    }
    current = parent;
  }
}

function toSqliteUrl(filePath: string): string {
  return `file:${path.resolve(filePath).replace(/\\/g, "/")}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(env);
  const softwareRoot = findSoftwareRoot();
  const home = path.resolve(value.ARCHIVIST_HOME?.trim() || softwareRoot);
  const dataDir = path.join(home, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(home, "memory", "projects"), { recursive: true });
  const defaultPrismaUrl = "file:../data/archivist.db";
  const databaseUrl = value.DATABASE_URL && value.DATABASE_URL !== defaultPrismaUrl
    ? value.DATABASE_URL
    : toSqliteUrl(path.join(dataDir, "archivist.db"));
  if (env === process.env) process.env.DATABASE_URL = databaseUrl;
  return {
    softwareRoot,
    home,
    databaseUrl,
    telegramToken: value.TELEGRAM_BOT_TOKEN,
    allowedUserIds: new Set(value.TELEGRAM_ALLOWED_USER_IDS.split(",").map(x => x.trim()).filter(Boolean)),
    timezone: value.ARCHIVIST_TIMEZONE,
    projectRoots: value.ARCHIVIST_PROJECT_ROOTS.split(",").map(x => x.trim()).filter(Boolean),
    llm: { provider: value.LLM_PROVIDER, apiKey: value.LLM_API_KEY, baseUrl: value.LLM_BASE_URL, model: value.LLM_MODEL },
    approvalTtlHours: value.APPROVAL_TTL_HOURS,
    catchUp: value.SCHEDULER_CATCH_UP.toLowerCase() !== "false"
  };
}

export type Config = ReturnType<typeof loadConfig>;
