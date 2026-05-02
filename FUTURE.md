# Patchwork — Roadmap

This file lists features intentionally deferred from v0.1 along with the architectural commitments that keep them cheap to add later. Items here are **not** TODOs in the codebase; they are forward-looking design notes for whoever picks the project up next.

The v0.1 scope is deliberately narrow: a single-user, terminal-driven, sequential pipeline with a non-negotiable human review gate. Every deferred feature was considered and explicitly excluded from v0.1 to keep the safety story simple. Nothing here is permitted to weaken the human review invariant.

---

## Architecture commitments preserved for the future

These are the v0.1 design choices that make the roadmap below a series of additions rather than rewrites. Future implementers should treat them as load-bearing.

| Commitment | What it enables |
|---|---|
| `ReviewSurface` is a strategy interface (`src/review/types.ts`) | Web, Slack, Telegram, or any other surface plugs in by implementing `present(payload): Promise<ReviewDecision>`. No pipeline changes. |
| `RunState` mutators are mutex-guarded (`src/reporter/runState.ts`) | Parallel agent execution can write into the same aggregator without races. |
| `DeferredQueue` persists `ReviewPayload` snapshots (`src/review/queue.ts`) | Async review sessions and queue-handoff between machines work today. |
| Cursor SDK is isolated behind `cursorClient.ts` | Model additions, vendor swaps, or transport changes are one file. |
| `MODEL_PRICES` is centralised (`src/reporter/costs.ts`) | Frontier-model rate updates are a single PR. |
| `pulls.create` has exactly one caller (`src/github/createPR.ts`), audited in CI | New review surfaces cannot accidentally bypass the gate. |
| `autoCreatePR: false` is type-locked | The Cursor SDK can never be invoked in auto-PR mode, in any code path. |

If a v0.2+ change requires loosening any of these, that is a sign the design is wrong — push back on the requirement instead.

---

## v0.2

### Web dashboard

**What.** A browser UI that complements (not replaces) the CLI. Kanban-style board grouping live agents by status: `triaging` / `running` / `awaiting review` / `pr created` / `rejected` / `skipped`. Diff viewer with syntax highlighting (Monaco or Shiki) and one-click approve/reject buttons that replace the terminal prompt.

**Why.** Reviewing 10+ diffs in a terminal is fine; reviewing them on a phone or tablet is not. A web surface unlocks async use without weakening the gate.

**What would be needed.**
- A new `WebReviewSurface` implementing `ReviewSurface`. The pipeline is unchanged.
- A small server (Hono / Fastify) that holds pending `ReviewPayload`s in memory, serves the UI, and resolves the surface's `present()` promise on user action.
- WebSocket for live agent status updates from the orchestrator into the UI.
- Auth — even single-user. Never expose review approval over an unauthenticated endpoint, even on localhost: a malicious page can still hit `127.0.0.1`.

**Reference.** Cursor's own kanban cookbook example is a reasonable starting scaffold for the agent-status board.

**Risks.**
- A web-only mode is a tempting place to add an "auto-approve" toggle for trusted repos. Don't. The disclosure-and-approval invariant is not negotiable; weakening it for "trusted" cases is exactly the slippery slope patchwork is designed to avoid.
- Browser surfaces can be left open while the operator walks away. Time-box pending reviews and require explicit re-engagement after, e.g., 30 minutes idle.

### Parallel agent execution

**What.** Multiple agents in flight concurrently, across different issues or even different targets in one run.

**Why.** Sequential execution is wasteful when agents spend most of their wall time waiting on Cursor's cloud. A user-configurable concurrency cap (default 3) would make patchwork much faster on repos with several promising issues.

**What would be needed.**
- `p-limit` (or hand-rolled equivalent) around the per-issue body of `runCommand`.
- Per-agent cost accounting flowing into the existing mutex-guarded `RunState`. The mutex is already in v0.1 specifically for this.
- A cost-projection guard at the *start* of each parallel slot: don't dispatch a new agent if `state.totalCostUsd + worstCaseEstimate > costLimitUsd`. The current `shouldAbortBeforeNextRun()` logic only handles sequential.
- Console reporter rework: ora doesn't compose well with multiple concurrent spinners. Replace with a static line-per-issue layout (think Docker Compose output).

**Risks.**
- **Cost explosion.** A bug in the dispatch loop running at concurrency 5 burns 5× the budget before the limit trips. The pre-dispatch guard is not optional.
- **Review-queue stampede.** Five agents finishing within seconds means five back-to-back review prompts. The terminal surface should serialise reviews; the web surface should show them as a board.

### Webhook / CI trigger mode

**What.** Run patchwork from a GitHub Actions workflow on `issues.opened`. Triage the new issue immediately; if it scores above threshold, queue it for the operator's next review session.

**Why.** Lets you run patchwork as a passive collector that surfaces interesting issues without you having to remember to invoke it.

**What would be needed.**
- A new `patchwork webhook` mode that takes an issue payload from stdin or env, runs triage only, and writes the result into the `DeferredQueue`.
- Hard-coded `dry_run: true` for any non-TTY invocation. The preflight already blocks non-TTY runs that need review; webhook mode is the explicit dry-run path.
- A note in the README warning operators that putting `CURSOR_API_KEY` into Actions secrets means CI can run agents — keep this mode triage-only and don't expose the agent key.

**Hard constraint.** This mode **never** creates PRs. Triage-only. Always. The webhook is a producer for the deferred queue; only an interactive `patchwork review` session can drain it.

---

## v0.3

### Multi-repo campaigns

**What.** Curate a list of repos for a single session — say, the top 50 repos that label `good first issue` — and let patchwork triage and report across all of them. Aggregate `SUMMARY.md` shows per-repo and overall stats. A leaderboard tracks PRs created, merged, and rejected over time.

**Why.** Once patchwork is reliable on one repo, the operational pattern of "run it on a curated list" emerges naturally.

**What would be needed.**
- A new top-level YAML shape: `campaigns:` containing arrays of targets, with shared budget caps.
- Persistent state at `.patchwork/history.json` accumulating run results across sessions (PR URLs, statuses checked over time).
- A leaderboard renderer (`patchwork stats`) that walks history and reports merge / close / open counts.

**Risks.**
- Maintainer fatigue. Patchwork is designed to discourage spam; multi-repo campaigns risk re-introducing it. The triage threshold should be raised globally for campaign mode (default 8 instead of 7), or operators should be required to confirm it.

### Learning loop

**What.** Track each created PR's eventual outcome (merged / closed-without-merge / still open after N days). Feed outcomes back into the triage pipeline so it learns the operator's personal acceptance pattern.

**Why.** Generic triage rubrics are a starting point; the operator's actual rejection patterns are the gold standard. A repo where the operator rejected the last 5 patchwork PRs probably should be deprioritised.

**What would be needed.**
- Cron / scheduled-run mode that polls open patchwork PRs (`gh pr view`) and updates `.patchwork/history.json` with their statuses.
- A second-pass triage step that takes the Haiku score and applies a per-repo or per-label adjustment based on history.
- Optionally: fine-tune a small triage model on the accumulated data once enough history exists. Not v0.3 work itself, but the data shape should support it.

**Risks.**
- Survivorship bias. If patchwork only ever creates PRs the operator approves, the "rejection" signal is sparse and skewed. The learning input should include human review rejections too — those are richer signal than maintainer rejections.

### Slack / Telegram review surfaces

**What.** Send the diff summary plus approve / reject buttons to a Slack channel or Telegram chat. Operator reviews from anywhere without opening a terminal.

**Why.** Async review without a laptop is the natural endpoint of the gate-as-strategy design. The operator should be able to review from a phone in five minutes, not have to wait for a desk session.

**What would be needed.**
- `SlackReviewSurface` and `TelegramReviewSurface` implementing `ReviewSurface`.
- A long-running daemon (or web-mode background process) that holds pending payloads and waits for button clicks. Slack and Telegram both support interactive components for this.
- Diff size handling — Slack message limits are tight. Send the file list and stats inline, attach the full diff as a snippet/file, and link to GitHub for deeper review.
- Authentication: messaging surfaces are public-ish. Tie the surface to a single user id; reject button presses from anyone else.

**Risks.**
- Mobile review encourages skimming. Lean into the friction: require explicit confirmation on diffs above a size threshold, even on mobile. Do not auto-approve just because the operator tapped a button by accident.

---

## Explicitly out of scope

These are deliberate exclusions, not deferred features. Adding them would compromise the project's design.

| Idea | Why not |
|---|---|
| "Auto-approve for trusted repos" / "auto-PR mode" | The whole point of patchwork is the gate. A toggle to disable it is the toggle to make patchwork into the kind of bot patchwork exists to avoid. |
| Hidden / suppressible AI disclosure | Submitting AI-assisted code without disclosure damages OSS trust. Non-negotiable. |
| Running on private repos as a hosted SaaS | Patchwork is an operator's tool. Hosting it would require credential custody and review-on-behalf semantics that the design intentionally avoids. |
| Maintainer-side reviewing with patchwork (auto-merge AI PRs) | Inverts the trust model. Patchwork is for contributors, not for accepting AI work. |
| Tighter integration with Cursor's billing for "free runs" | Cost transparency is the point; the operator should always see the dollar number. |

---

## How to propose additions

Open an issue describing the feature and which architecture commitment it relies on. If the feature requires loosening any commitment in the table at the top, the issue should explain why the safety story still holds without it. If the answer is "we'd just add a flag," the answer is no.
