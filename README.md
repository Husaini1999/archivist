# Archivist

Archivist is a central, terminal-first AI software team for multiple existing Git repositories. It analyzes projects, stores project-specific memory in this repository, proposes improvements, requests Telegram approval, implements work on isolated branches, validates the result, and asks a human before any commit or push.

## 1. Status and MVP scope

This MVP contains a working TypeScript CLI, Prisma/SQLite data model, repository discovery, memory service, heuristic and OpenAI-compatible analysis, agent runtime, daily scheduler, grammY bot, approval state handling, privileged Git boundary, and Vitest suite. LLM implementation requires a configured provider; offline analysis and suggestions remain deterministic.

## 2. Requirements

- Node.js 20 or newer, npm, and Git on `PATH`
- An existing Git repository to manage
- Optional Telegram bot token and OpenAI-compatible LLM credentials

## 3. Install

Windows PowerShell:

```powershell
cd "C:\Users\USER\Downloads\Development Projects - Husaini\archivist"
Copy-Item .env.example .env
npm install
npm run db:push
npm run build
```

Unix:

```bash
cd /path/to/archivist
cp .env.example .env
npm install
npm run db:push
npm run build
```

The default database is `data/archivist.db`; it is ignored by Git.

## 4. Configuration and secrets

All secrets come from environment variables. See `.env.example`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `ARCHIVIST_TIMEZONE`, `ARCHIVIST_PROJECT_ROOTS`, `ARCHIVIST_HOME`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `APPROVAL_TTL_HOURS`, and `SCHEDULER_CATCH_UP`. Never commit `.env`.

## 5. Registering projects

From a target repository:

```bash
npx tsx /path/to/archivist/src/cli/index.ts init
```

Or centrally:

```bash
archivist --repo /path/to/repository init
archivist projects
archivist projects scan
```

Scanning reads comma-separated `ARCHIVIST_PROJECT_ROOTS`, examines immediate child directories, resolves real paths, deduplicates repositories, skips invalid directories, and skips Archivist itself.

## 6. CLI

The source CLI is `npx tsx src/cli/index.ts`; after build use `node dist/src/cli/index.js` or the installed `archivist` binary. Commands:

```text
archivist
archivist --repo /path/to/project
archivist init
archivist projects
archivist projects scan
archivist analyze
archivist suggest
archivist daily
archivist work
archivist status
archivist history
archivist diff
archivist test
archivist review
archivist approve
archivist reject
archivist pause
archivist resume
archivist daemon
```

Use `--project <slug-or-name>`, `--repo <path>`, and `--json`. Git root discovery walks upward from the current directory.

## 7. Multiple-project registry

`Project` stores name, slug, canonical Git root, branch, detected technology, metadata, automation flags, timestamps, last known commit, and memory identity. Projects are isolated by ID and memory slug. Automatic daily work only considers enabled, unpaused projects.

## 8. Project memory

Memory is stored only under:

```text
memory/projects/<slug>/
  profile.md
  architecture.md
  decisions.md
  priorities.md
  technical-debt.md
  history/YYYY-MM-DD.md
```

Archivist does not create `.archivist` in target repositories. Memory contains summaries, paths, and evidence—not source copies or full diffs. Secret-like values are redacted. History supports Analysis, Recommendation, Decision, Implementation, Validation, Git, and Learning sections.

## 9. Daily scheduler

The default schedule is 08:00 in `Asia/Kuala_Lumpur`. `archivist daily` runs once immediately; `archivist daemon` starts cron and Telegram polling. `(projectId, dateKey)` is unique, preventing duplicate daily runs. Failures are recorded and do not result in duplicate sends. Catch-up is configurable; this MVP exposes the setting and normal manual `daily` invocation, but does not infer downtime across machine restarts.

## 10. Telegram

Set a bot token and comma-separated numeric allowlist. The first allowlisted ID is used as the default private chat destination. Supported commands are `/projects`, `/enable <project>`, `/disable <project>`, `/now <project>`, `/status`, `/history <project>`, `/pause [project]`, and `/resume [project]`.

Morning proposals include concise evidence and explicitly qualitative estimated impact, effort, risk, and confidence. Buttons use short database callback tokens and stay below Telegram's 64-byte limit. Tokens bind to a project and proposal/task, expire (48 hours by default), are single-use, and require an allowlisted user.

## 11. Approval lifecycle

Proposal approval creates an approved task. If paused, it remains queued; resume does not execute it automatically. `archivist work` starts the oldest approved task. Successful implementation becomes `AWAITING_COMMIT` and creates a separate commit approval. Declining leaves changes and the AI branch intact. Push requires its own `PUSH` approval and is never automatic.

## 12. Programmatic Git safety

Safety is structural, not prompt-only:

- `src/tools/registry.ts` constructs the agent registry and physically omits `gitCommit` and `gitPush`.
- `runCommand` accepts argv arrays, permits selected development executables, and denies Git commit/push and dangerous shell/system commands.
- File tools resolve real paths and require them to remain under the target repository.
- `src/git/git.ts` owns `PrivilegedGitService`; `commit` and `push` require a matching, unexpired, already-approved database record.
- Agent prompts also reinforce the boundary, but prompts are not the security control.
- Tests prove absent tools, restricted command denial, path containment, and approval enforcement.

## 13. Agent team

Handbooks live in `prompts/`: Lead/PM, Product, UX, Frontend, Backend, QA, and Reviewer. The runtime exposes only its injected allowlist, limits tool iterations to 12, applies an overall timeout, returns tool errors to the loop, and validates final structured output with Zod. It never evaluates generated code or arbitrary tool names.

## 14. LLM providers and offline mode

`LLMProvider.chat` abstracts model access. `OpenAICompatibleProvider` uses standard chat-completions HTTP, while `MockLLMProvider` supports deterministic tests. Without credentials, Archivist inspects repository metadata, tests, status, and TODO/FIXME evidence and labels recommendations heuristic. Actual source implementation requires an LLM configuration.

## 15. Implementation workflow

Approved work runs on `ai/task-<id>-<slug>`. Archivist refuses to execute paused projects, invokes Lead, implementation, QA, and Reviewer roles, records each `AgentRun`, captures diff stats, updates memory, and reports that no commit has been made. Agents follow existing project conventions and can read/edit/test/build/review but cannot commit or push.

## 16. Learning and external changes

The schema includes sessions, proposals and fingerprints, accepted/rejected status, tasks, agent runs, external changes, Git operations, and audit logs. Exact pending or rejected recommendation fingerprints are suppressed. `ExternalChange` supports recording human commits detected between sessions; richer attribution and automatic import are an MVP follow-up.

## 17. Pause and project management

Global and per-project pause states persist in SQLite. Paused projects are skipped by the scheduler and work runner. Enable/disable controls daily suggestions independently from pause. Resume is non-destructive and does not launch queued work.

## 18. Database and state

The Prisma schema defines `Project`, `Session`, `DailyRun`, `Proposal`, `Task`, `AgentRun`, `Approval`, `GitOperation`, `ScheduleSettings`, `ExternalChange`, `AuditLog`, and `TelegramMessage`. Run `npm run prisma:generate` after schema changes and `npm run db:push` for local MVP deployment. Production upgrades should use checked-in Prisma migrations and backups.

## 19. Testing and operations

```bash
npm test
npm run typecheck
npm run build
```

Tests use temporary Git repositories and cover Git-root walking, technology detection, command/path security, privileged approval requirements, memory isolation/redaction/history, timezone date keys, Telegram parsing, agent tools and structured output, proposal decisions, expiration, and unauthorized users.

For long-running deployment:

- PM2: `pm2 start dist/src/cli/index.js --name archivist -- daemon`
- systemd: create a service with `WorkingDirectory`, `EnvironmentFile`, and `ExecStart=/usr/bin/node .../dist/src/cli/index.js daemon`
- Windows NSSM: install `node.exe` as the application, set startup directory to this repository, and arguments to `dist/src/cli/index.js daemon`

Use one daemon instance per database. Restrict filesystem permissions on `.env`, `data`, and the repository.

## 20. MVP decisions and future improvements

The MVP deliberately uses SQLite, immediate-child root scanning, one OpenAI-compatible HTTP adapter, a compact sequential agent team, and private-chat delivery. Next steps: checked-in migrations, robust catch-up startup logic, automatic external-change ingestion/attribution, a dedicated push-approval UX, richer Telegram implementation reports and project buttons, per-role tool policies, sandboxed process isolation, retry/backoff and telemetry, memory-commit CLI UX, patch conflict recovery, additional technology-specific validators, and end-to-end bot tests against a disposable Telegram environment.

No target code or Archivist memory is committed or pushed automatically.
