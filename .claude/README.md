# Claude Code automation for patchwork

This directory configures Claude Code to enforce patchwork's safety invariants automatically and to make phase-by-phase development of the codebase fast and consistent. It is checked into the repo so every contributor gets the same setup.

If you are new here, start with `CLAUDE.md` (root) — it states the architecture, the 10 non-negotiable invariants, and the phase ordering. Everything in this directory exists to support those rules.

## Layout

```
.claude/
├── README.md                         ← you are here
├── settings.json                     ← team-shared hooks + permissions
├── settings.local.json               ← your personal overrides (not shared)
├── hooks/
│   ├── invariant-audit.sh            ← post-edit grep audit (CLAUDE.md § CI checks)
│   └── post-edit-check.sh            ← post-edit typecheck + lint
├── agents/
│   ├── invariant-reviewer.md         ← audits diffs against the 10 invariants
│   └── prompt-injection-reviewer.md  ← audits prompt-construction for injection
└── skills/
    └── phase-advance/
        └── SKILL.md                  ← deliberate phase-by-phase scaffolding
```

## Hooks (run automatically)

Both hooks fire after every `Edit`, `Write`, or `MultiEdit` Claude makes. They block on failure (exit 2), so a violation surfaces immediately in the same turn instead of in CI.

### `invariant-audit.sh`
Mirrors the three CI grep checks from `CLAUDE.md` § "CI audit checks":

1. `octokit.pulls.create` outside `src/github/createPR.ts`
2. `autoCreatePR: true` anywhere
3. `@octokit/rest` imports outside `src/github/**`

Test files (`__tests__/`, `*.test.ts`) are excluded, mirroring `.eslintrc.cjs`.

### `post-edit-check.sh`
For edits to `src/**/*.ts`, runs `tsc --noEmit` (project-wide) and `eslint <file>`. Exits 0 quickly for non-TypeScript edits.

### Tips
- Run a hook manually any time: `bash .claude/hooks/invariant-audit.sh`.
- If a hook becomes too slow, profile before disabling — the cost of catching a `pulls.create` regression in CI is much higher than a few seconds per edit.
- To temporarily skip: rename `settings.json` for the session. Don't disable per-edit; you'll forget it's off.

## Subagents (run on demand)

Subagents have their own context window — useful for long checks that would bloat your main conversation.

### `invariant-reviewer`
**When to spawn:** before commits or PR creation, especially after diffs touching PR creation, `ReviewSurface`, `RunState`, `autoCreatePR`, `ReviewDecision`, or anything imported from `@octokit/rest` / `@cursor/sdk`.

**How to invoke:** ask Claude to "spawn the invariant-reviewer subagent on the staged diff" (or `git diff main...HEAD`). Claude routes it through the `Agent` tool with `subagent_type: invariant-reviewer`.

**What you get back:** a `PASS`/`FAIL` verdict with `file:line` citations against the 10 invariants and the three CI greps. Don't ship a phase if it returns `FAIL`.

### `prompt-injection-reviewer`
**When to spawn:** any diff that touches `src/agent/`, the Haiku triage prompt, the Cursor agent skill (`.cursor/skills/oss-contributor.md`), or code that interpolates issue title/body/comments/labels into a model call, PR body, or shell.

**Threat model:** issue authors are adversarial. The reviewer checks delimiter robustness, instruction smuggling, truncation safety, body-as-system-prompt mistakes, shell interpolation, and PR-output sanitization.

**Maximize value:** invoke it preventively when you start writing prompt code, not as a post-hoc audit. It's cheaper to design delimiters correctly the first time than to retrofit them.

## Skills (you invoke)

### `/phase-advance <N>`
Deliberate, user-only skill (`disable-model-invocation: true`) — Claude won't auto-invoke it. Use it whenever you want to start the next phase from `PLAN.md`. It walks the spec → scaffolds files in PLAN.md order → tests → verifies → asks the `invariant-reviewer` subagent → updates CLAUDE.md "Repository state" → stops.

The skill refuses to skip phases or pull `FUTURE.md` features into v0.1.

### Skills you have via plugins (no setup needed)
- `/simplify` — reviews changed code for reuse, quality, dead complexity. Aligns with `CLAUDE.md`'s "no half-finished implementations / no premature abstractions" guidance.
- `/security-review` — full security review of pending changes. Use this on phase boundaries in addition to the prompt-injection-reviewer.
- `/review` — review a pull request.
- `/commit` — guided git commit.

## MCP servers

### context7 (live library docs)
Patchwork depends on three SDKs that move fast: `@cursor/sdk` (pinned to `latest` in `package.json`!), `@anthropic-ai/sdk@0.30.0`, and the Octokit ecosystem. Stale knowledge produces broken code.

**Maximize value:** before writing any code that calls a Cursor SDK / Anthropic SDK / Octokit method you haven't used recently, ask Claude to fetch fresh docs with context7. Particularly important for:
- `@cursor/sdk` — durable cloud agents, event resumption (`resumeEvents`), `autoCreatePR` parameter shape (must accept literal `false`).
- `@octokit/rest` — fork creation, PR creation parameters.
- `@anthropic-ai/sdk` — Haiku model IDs, response format, prompt caching.

### GitHub MCP
Patchwork *is* a GitHub tool, but you can also use GitHub MCP for managing patchwork's own repo — issues, PR review on this codebase, releases. Don't confuse the two: GitHub MCP is for *developing* patchwork; patchwork's own `src/github/` is the production code path it ships.

## Permissions

`.claude/settings.json` pre-allows safe local commands (`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx eslint *`, `git diff/status/log`). `.claude/settings.local.json` already has `npx tsc *` and `npx vitest *` for personal use. Both are merged at runtime; local takes precedence.

If a contributor needs broader permissions for a task, add them to `settings.local.json`, not `settings.json`. The shared file should stay minimal and read-only-ish — anything destructive deserves an explicit prompt.

## How these layers combine

Think of it as defense in depth, with each layer catching what the previous one missed:

1. **`.eslintrc.cjs`** — static lint rule blocks `@octokit/rest` imports outside `src/github/**` at lint time.
2. **`hooks/invariant-audit.sh`** — runs the three grep audits after every edit so the *substance* of the rules (not just their lint surrogate) is enforced live.
3. **`hooks/post-edit-check.sh`** — typecheck + lint catch type widening (e.g. `autoCreatePR` becoming `boolean`) and code-style regressions immediately.
4. **`invariant-reviewer` subagent** — pre-PR, semantic check across the whole diff. Catches things grep can't (e.g. a wrapper that re-exports `pulls.create` under a different name).
5. **`prompt-injection-reviewer` subagent** — pre-PR, threat-model check of any prompt-touching diff.
6. **CI** — same grep audits run server-side as the final backstop.
7. **The human review gate** — invariant #3, the architectural backstop. No PR ships without explicit approval.

Each layer should rarely catch something the previous layer missed. When it does, harden the previous layer.

## Adding more automation later

Don't accumulate hooks/agents/skills speculatively — each one is context the model has to carry. Add a new layer only when you can point to a real incident or near-miss it would have caught. The `claude-code-setup:claude-automation-recommender` skill (already installed) can suggest more options when the codebase grows.
