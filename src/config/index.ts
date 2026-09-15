import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultHome = path.resolve(here, "../../..");

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  ARCHIVIST_TIMEZONE: z.string().default("Asia/Kuala_Lumpur"),
  ARCHIVIST_PROJECT_ROOTS: z.string().default(""),
  ARCHIVIST_HOME: z.string().optional(),
  DATABASE_URL: z.string().default("file:../data/archivist.db"),
  LLM_PROVIDER: z.string().default("openai-compatible"),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().optional(),
  APPROVAL_TTL_HOURS: z.coerce.number().positive().default(48),
  SCHEDULER_CATCH_UP: z.string().default("true")
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(env);
  const home = path.resolve(value.ARCHIVIST_HOME ?? defaultHome);
  return {
    home,
    databaseUrl: value.DATABASE_URL,
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
