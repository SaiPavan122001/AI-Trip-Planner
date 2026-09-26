# CLAUDE.md — read this first in every session

Wayfare (AI Trip Planner): a TypeScript monorepo, India-focused, INR only. Read, in this order:
`CLAUDE.md` (this file) → `PROJECT_STATUS.md` (where things stand) → `PHASE_PLAN.md` →
`DECISIONS.md`. Then check `git status` and `git log --oneline -5` before doing anything.

## Hard environment rules (from the user; absolute)

- The project is on a USB drive: `H:\Projects\Mutli Agent AI Trip Planner\AI-Trip-Planner`
  (note the spelling "Mutli"). C: is nearly full (345 MB free at the end of Phase 1; 2.5 GB after the user freed space during Phase 2).
- **Nothing project-related may be written to C:** — no node_modules, npm cache, TEMP/TMP output,
  databases, logs, builds, virtualenvs, or global installs. Before installing anything, work out
  where it will be written; if it cannot stay on H:, stop and ask.
- Before every npm/node command in a shell: `source "/h/Projects/Mutli Agent AI Trip Planner/.devcache/env.sh"`
  (PowerShell: `.devcache\env.ps1`). It points the npm cache, TEMP/TMP and APPDATA at
  `H:\...\.devcache` (a sibling of the repo, not versioned) and disables telemetry.
- Do not reinstall or relocate system software (Node, Git, Docker, VS Code, Claude Code).
- If C: free space is low or shrinking, tell the user; do not start heavy work.

## Working rules the user set

- **Do not push. Do not open a PR.** Work stays on the local branch.
- Booking is **disabled** and stays so. Never ask for API keys or credentials; use env
  placeholders.
- **Agents (changed in Phase 2, by the user):** the multi-agent architecture in `packages/agents`
  is in scope and is the product's design. Earlier sessions were told "no agents"; that was
  superseded by the user's Phase 2 instruction. Still no agent *frameworks* (LangChain and the
  like), no single "master" planner agent, and **no RAG, vector database or embeddings** (the user
  ruled these out for Phase 2; a knowledge layer would be a separate, user-approved phase). Do not
  start Phase 3 unless asked.
- **Agents are untrusted.** LLMs/agents understand, interpret and explain; deterministic code owns
  prices, totals, dates, durations, constraints, validation, ranking, state changes, persistence and
  authorisation. Agent output is checked before use, never written to a store by an agent, and
  never allowed to bypass validation, consent, ownership or the budget rules. External text
  (traveller, provider, destination) reaches a model only as delimited data, never as instructions.
- Never delete the old npm cache on C: (the user asked for it to be left alone).
- No destructive DB commands. Do not weaken tests, lint or TypeScript. Never claim a check passed
  unless it was executed.
- Do not upgrade major dependencies (Next.js, Vitest, …).
- Ask the user only if a decision (1) changes an explicit product requirement, (2) has materially
  different interpretations, (3) needs an external credential/service that is unavailable, or
  (4) blocks safe progress. Otherwise decide, and record important decisions in `DECISIONS.md`.
- Commit messages end with the attribution line given by the harness
  (`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` was used so far).

## Product principles (fixed by the user)

India-focused, INR only · self-drive fare is ₹0 with fuel/wear kept separate · friendly and flexible ·
users can pin components; invalid pins (after date/party changes) are identified and the user is told ·
explain plan-affecting changes and get consent where required · date changes re-plan affected parts ·
budget is a guide by default, "do not exceed ₹X" is a hard limit · hotel suitability counts in plan
ranking · local development with Docker where needed, architecture ready for production without
production-specific assumptions.

## Layout

npm workspaces. `packages/shared` (Zod domain model, INR money) → `packages/providers` (vendor
adapters, `httpJson`) → `packages/llm` (narrow router; output untrusted) → `packages/engine`
(deterministic planner) → `packages/agents` (planning agents, budget and validation services,
orchestrator; Phase 2) → `apps/api` (Fastify 5, Prisma 5.22, Zod) and `apps/web` (Next 15.5,
React 18, Tailwind 3). Tests: Vitest 2.1. Lint: ESLint 10 flat config at the root. Node ≥ 22.
Docs: `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/providers.md`, `docs/booking.md`,
`SECURITY.md`, `CONTRIBUTING.md`.

## Commands (after sourcing env.sh, from the repo root)

```
npm run lint          npm run typecheck        npm run build       npm test
npm run test:integration   # real embedded PostgreSQL 16 (no Docker); needs a built @trip/shared etc.
npm run smoke              # built API + worker end to end (run `npm run build` first)
# separate worker process (this exact form was run and passed): from apps/api,
#   node scripts/smoke.mjs --split
npm run dev / dev:api / dev:web / dev:worker
```

Build order matters: packages must be built (`npm run build`) before the API/web typecheck or tests
see their changes.

## Conventions worth knowing

- Money is integer minor units; only INR (`SUPPORTED_CURRENCY`). `@trip/shared/currency` is a
  dependency-free subpath for the browser.
- Provider results are a tagged union with provenance; never fabricate data; unknown price ≠ ₹0.
- The LLM only classifies modification requests; its output is sanitised per field and the text shown
  to travellers is written from the validated request, never by the model.
- The API talks to the `Store` interface (trips + runs + identity); `InMemoryRepository` and
  `PrismaRepository` must both pass `apps/api/src/__tests__/support/store-contract.ts`.
- Schema changes: add a new additive Prisma migration; never edit a released one. (The init migration
  was corrected once, in Phase 1, because it could never have applied.)
- The agent contract (`packages/agents/src/contract.ts`): model call → strict schema → deterministic
  sanitiser → structured outcome (`ok` / error code); a rule-based fallback when there is no model
  or its output is unusable. Requirements need a real quote from the traveller's words; guidance
  fills gaps only; narratives are fact-checked and replaced by a template on failure.
- Match surrounding code style and comment density.

## Observed tooling quirks

- In the Bash tool, large heredocs containing quotes or `${…}` sometimes fail with "unexpected EOF".
  Use the Write/Edit tools for files, or write a small script file and run it with node.
- **Backslashes in Bash heredocs and `sed`/`node -e` strings get halved or corrupted** (a `\b` regex
  became a backspace character; `sed 's/\`/`/g'` prefixed every line with a backtick). Write files
  and edit scripts with the Write/Edit tools, run scripts from files, and avoid `sed` with
  backslashes. `.devcache/tmp/fix-bs.cjs` repairs backspace characters in the agents package.
- Paths contain spaces: quote them (an unquoted `$L/…` log path failed once).
- Many files are CRLF in the working tree while the repo stores LF (`.gitattributes`); git prints
  harmless CRLF warnings. Edit scripts normalise line endings.

## When a new session starts

Follow the "Exact next step" section at the bottom of `PROJECT_STATUS.md`.
