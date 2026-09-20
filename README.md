# 🗂️ Archivist

**Human-governed AI software team** for the Git repos already on your machine. It proposes improvements in Telegram, implements on an isolated branch, runs tests/build/runtime checks, and still **never commits or pushes without you**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Prisma](https://img.shields.io/badge/Prisma-6.15-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Playwright](https://img.shields.io/badge/Playwright-1.63-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)

This repository is the **public product**. Clone *this* repo. Project history, SQLite, and secrets belong in a **personal instance**, not in the public tree.

## ✨ What it does

- 📥 Registers existing Git repos (it does not create a new app for you)
- 🧠 Keeps per-project memory (profile, decisions, day logs)
- 🌅 Sends daily recommendations in Telegram at 08:00 in your timezone
- ✅ Lets you accept/decline each rec, then **Apply**
- 🌿 Implements accepted work on `ai/<project>/...` from `main`/`master`
- 🧪 Runs tests, lint, typecheck/build, then boots the app in Chrome/Edge
- 🔁 Sends console/runtime failures back to the agent (up to twice) before offering a PR
- 🔒 Never merges to production. One approval opens a pull request

## 🧰 Stack

| | Version |
|---|---|
| Node.js | `>=20` |
| TypeScript | `5.9` |
| Prisma + SQLite | `6.15` |
| Grammy (Telegram) | `1.38` |
| Zod | `4.1` |
| Commander | `14` |
| node-cron | `4.2` |
| dotenv | `17` |
| Playwright (runtime smoke) | `1.63` |
| Vitest | `3.2` |
| tsx | `4.20` |

Chrome or Edge must be installed for the runtime console check. Playwright-core uses the browser already on the machine; it does not download Chromium.

## 📦 Public product vs personal instance

**Keep personal memory out of the public GitHub repo.**

| | Public `archivist` | Personal instance |
|---|---|---|
| GitHub | This repo (software, prompts, docs) | Private repo *or* a local folder |
| Contains | CLI, agents, schema, empty `memory/projects/` | `memory/projects/<your-apps>/`, SQLite, `.env` |
| Who clones it | Anyone | Only you |
| Updates | `git pull` | Pull software from public; commit memory privately |

### A. Simple clone (try it)

Clone the public product and run it in place. Memory and SQLite stay on disk. Do **not** push those files (`memory/projects/*/` and `data/*.db` are gitignored).

```bash
git clone https://github.com/Husaini1999/archivist.git
cd archivist
cp .env.example .env
npm install
npx prisma db push
npm test
npm run build
npx tsx src/cli/index.ts
```

### B. Personal history git (recommended)

```text
~/archivist/            ← clone of the public product (pull updates here)
~/archivist-home/       ← private git repo (memory + optional DB backups)
```

```bash
git clone https://github.com/Husaini1999/archivist.git ~/archivist
git init ~/archivist-home
mkdir -p ~/archivist-home/memory/projects ~/archivist-home/data
```

In `~/archivist/.env`:

```env
ARCHIVIST_HOME=/absolute/path/to/archivist-home
```

Leave `DATABASE_URL` as the example (or unset it). SQLite lives at `$ARCHIVIST_HOME/data/archivist.db`. Prompts load from the software clone. Memory goes to `$ARCHIVIST_HOME/memory/projects/<slug>/`.

Push `archivist-home` to a **private** GitHub repo — not this product. Do **not** nest a clone of the public repo inside the personal memory repo.

## 📋 Status

Working MVP: CLI, Prisma/SQLite, discovery, memory, heuristic and OpenAI-compatible analysis, agent runtime, 08:00 scheduler, Telegram approvals, privileged Git boundary, runtime smoke, and tests. Implementing source changes needs an LLM key. Offline analyze/suggest still works and is labeled heuristic.

It is **not** a polished SaaS. Catch-up after downtime, automatic external-change import, and dedicated push-approval UX are still follow-ups.

## ⚙️ Requirements

- Node.js 20+, npm, Git on `PATH`
- Chrome or Edge (runtime smoke before Open PR)
- Optional Telegram bot token and OpenAI-compatible LLM credentials
- Existing Git repositories you want Archivist to manage (targets stay separate Git repos)

## 🔐 Configuration

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric user IDs; others are denied |
| `ARCHIVIST_TIMEZONE` | Default `Asia/Kuala_Lumpur` |
| `ARCHIVIST_PROJECT_ROOTS` | Comma-separated directories to scan for Git repos |
| `ARCHIVIST_HOME` | Personal instance root (memory + DB). Empty = this clone |
| `DATABASE_URL` | Prisma CLI URL. Node overrides to `$ARCHIVIST_HOME/data/archivist.db` when left as the example |
| `LLM_*` | OpenAI-compatible provider. `LLM_TPM_LIMIT` default 200000; Archivist waits at 75% instead of 429ing |
| `APPROVAL_TTL_HOURS` | Default 48 |
| `SCHEDULER_CATCH_UP` | Setting exists; this MVP does not reconstruct missed days after a crash |

## 📁 Registering target projects

From a **target** repository (not from Archivist itself):

```bash
npx tsx /path/to/archivist/src/cli/index.ts --repo /path/to/target init
```

Or after linking the binary:

```bash
archivist --repo /path/to/target init
archivist projects
archivist projects scan
```

`init` does **not** write `.archivist/` into the target. Memory is created under `ARCHIVIST_HOME/memory/projects/<slug>/`.

## 🖥️ CLI

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

`--project <slug-or-name>`, `--repo <path>`, `--json` are supported.

## 🧠 Memory

```text
$ARCHIVIST_HOME/memory/projects/<slug>/
  profile.md
  architecture.md
  decisions.md
  priorities.md
  technical-debt.md
  history/YYYY-MM-DD.md
```

Summaries, paths, and evidence only. Secrets are redacted. Full source copies and full diffs are not stored.

## 📅 Daily 08:00 and Telegram

`archivist daily` runs once. `archivist daemon` starts cron (08:00 in the configured timezone) and Telegram polling.

Only projects with `autoImproveEnabled=true` and `paused=false` participate. `(projectId, dateKey)` is unique so a restart does not double-send.

Allowlisted Telegram users can `/projects`, `/enable`, `/disable`, `/now`, `/history`, `/pause`, `/resume`. Approval buttons use short server-side tokens (not trusted payloads). Unauthorized users are denied.

Automatic improvement means: morning suggestion → human selects recs → Apply → agents implement accepted recs on one branch from `main`/`master` → one approval opens a pull request. It never merges into production.

## 🛡️ Git safety

Structural, not prompt-only:

- Agent tools omit `gitCommit` and `gitPush`
- `runCommand` denies git commit/push
- File tools cannot leave the target repository
- `PrivilegedGitService` requires a valid, unexpired, already-approved record

Agents create `ai/<project>/<title>-<id>` (or `ai/<project>/N-improvements-<id>` for a batch) from `main`/`master` and must not edit those branches in place. Approving a finished task commits, pushes, and opens one PR; it does not merge.

## 🤖 Agents

Handbooks in `prompts/`. Implementation uses one backend pass (not four agents per rec), allowlisted tools, 8-iteration cap, truncated tool output, and a tokens-per-minute budget that waits instead of 429ing.

After edits, Archivist runs tests/lint/typecheck-or-build, boots the app in Chrome/Edge, and fails the commit if the console throws. Failed checks are sent back to the agent twice to fix before Telegram offers Open PR.

## 🧪 Testing and ops

```bash
npm test
npm run typecheck
npm run build
```

Long-running:

- PM2: `pm2 start dist/cli/index.js --name archivist -- daemon`
- systemd / NSSM: `node dist/cli/index.js daemon` with `WorkingDirectory` and `EnvironmentFile`

One daemon per database. Restrict permissions on `.env`, `data/`, and `ARCHIVIST_HOME`.

## ⚠️ Security limitations

This MVP is a local operator tool. It is not a multi-tenant cloud. Anyone with filesystem access to the instance can read memory and the database. Keep the personal instance private. Do not expose the Telegram bot to the public internet without the allowlist. LLM providers receive repository excerpts you analyze; do not register secret-bearing repos without redaction review.

## 📄 License

MIT. See [`LICENSE`](LICENSE).
