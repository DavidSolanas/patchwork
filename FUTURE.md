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

## v0.1.x — Prompt fidelity and reporting accuracy

These are correctness bugs discovered in the first real run of v0.1. None requires a feature flag or architectural change; they are small, targeted patches to three files. They are batched here rather than fixed immediately because they interact (summary extraction and test-guidance framing both feed the PR body) and should be tested together.

### Inline the OSS contributor skill into the agent prompt

**What.** `buildPrompt` ends with `Refer to .cursor/skills/oss-contributor.md for full OSS contribution norms.` The Cursor SDK discovers `.cursor/skills/` from the *bound repo* — the fork or upstream. Target repos do not carry patchwork's skill file, so the reference is silently dead; the agent has no access to it.

**What would be needed.**
- Read `.cursor/skills/oss-contributor.md` at `buildPrompt` call time. Add `skillContent: string` to `BuildPromptContext` and replace the reference line with the literal file content. `runAgent` supplies the content by calling `fs.readFile` once before invoking `buildPrompt`; a `DEFAULT_SKILL_CONTENT` constant can serve as a compile-time fallback if the read fails.
- Remove the now-dead "Refer to..." line. Do not add a second path reference anywhere.

**Risks.**
- Token budget: the skill file is ~80 lines (~1 200 chars). Negligible relative to current prompt size.
- Drift: the inlined copy is frozen at prompt-build time. Acceptable for v0.1.x.

### Improve test-guidance framing in the agent prompt

**What.** `buildPrompt` emits bare command names (`pytest`, `npm test`) as "Test guidance" with no caveat that the runner may not be available in the Cursor cloud environment. Agents that cannot run the suite emit confusing output ("pytest was not runnable here — python3-venv missing") that propagates verbatim into the PR body's testing section. The `testingNotes` string in `runAgent` compounds this: it reads `Test commands detected: pytest` even if the agent never ran a single test.

**What would be needed.**
- In `buildPrompt`, wrap the test hints with explicit framing: *"These test commands were detected in the repository. Run them after making your changes if the runner is available in your environment. If it is not, state that explicitly — do not leave the testing notes blank."*
- In `runAgent`, change the `testingNotes` string to `"Test runner detected but environment availability unverified: pytest"` (or "No test commands detected") so the PR body is honest about what was found versus what ran.

**Risks.** None — purely informational framing, no logic change.

### Structured `<summary>` block for reliable PR-body extraction

**What.** `parseResult.extractSummary` takes the last non-empty, non-code paragraph from the agent's output. In practice the agent's last paragraph is often meta-commentary about the branch it pushed or a note about PR creation, not a description of what changed. The resulting "What was changed and why" section in the PR body is misleading or useless.

**What would be needed.**
- Add a `<summary>…</summary>` instruction to `buildPrompt` (analogous to the existing `<patch>` block): the agent must emit a 2–5 sentence description of what changed and why, between `<summary>` and `</summary>` tags, placed *before* its `<patch>` block.
- Add a `SUMMARY_BLOCK = /<summary>([\s\S]*?)<\/summary>/` regex to `parseResult.ts`. In `parseResult`, try the structured block first; fall back to `extractSummary`'s last-paragraph heuristic when the tag is absent (preserving current behaviour for non-compliant outputs).
- In `cursorClient.snapshotOf`, strip the `<summary>` block from `output` before returning it, mirroring how `<patch>` is already stripped (line 148). This prevents the last-paragraph fallback from accidentally matching the summary tag's literal text.

**Risks.**
- Agents may omit the tag — the heuristic fallback handles those runs.
- `<summary>` is a common HTML element; use a non-greedy regex and do not apply the nonce mechanism used for `<issue_body>` (the agent, not untrusted user input, generates this block).

### Cost tracking always reports $0 (Cursor SDK v1.x limitation)

**What.** The run summary always shows `$0.00 (composer-2, 0 in / 0 out / 0 cache)`. The event consumer in `runAgent` is correct — it accumulates `CursorEvent.tokens` deltas — but `cursorClient.streamEvents` deliberately emits zero-token events because "The v1.x SDK does not yet surface token usage on stream messages" (comment at line 124 of `cursorClient.ts`). Operators see a $0.00 spend figure and cannot trust the cost limit.

**What would be needed.**
- When the Cursor SDK exposes usage on stream messages or on the completed `Run` object, map the fields into `CursorEvent.tokens` inside `streamEvents`. No caller changes are needed — the accumulator in `runAgent` is already correct.
- If the SDK exposes aggregate usage on `run.result` post-completion, read it in `snapshotOf` and add an optional `usage?: TokenUsage` field to `RunSnapshot`. Thread it into `finish()` as an override when the event-accumulated total is zero, without changing the `TokenUsage` shape downstream.
- Until the SDK exposes the data, render `"cost unknown"` instead of `$0.00` in `ConsoleReporter` and `writeSummary` when `costUsd === 0` and all token fields are zero. This makes the gap visible to operators rather than implying the run was free.

**Risks.**
- The SDK API is under active development; field names may differ from the assumption above. Pin to the SDK release that first exposes usage, update `streamEvents`, and add a regression test against a mock event that carries non-zero usage.

### `[T]est locally` shortcut in the review prompt + honest AI disclosure

**What.** The AI Disclosure block in every PR body previously read "reviewed, tested, and approved by the author." In practice the review prompt only showed a terminal diff — there was no mechanism for the human to actually run the code before approving. The claim was false. The immediate fix (already applied) removes "tested" from the disclosure. This item tracks restoring it honestly: adding a `[T]est locally` option to the review prompt that gives the operator the exact git commands to check out the branch, then tracks whether they used that path before approving, and restores the "tested" wording only when they did.

**What would be needed.**

*`src/types.ts`*
- Extend the `approve` arm of `ReviewDecision` to carry a flag: `{ action: 'approve'; testedLocally: boolean }`. This is a new field on an existing action, not a new action, so the exhaustive `const _: never = decision` switch (invariant #10) requires no new arms — but the caller that pattern-matches `action === 'approve'` must destructure `testedLocally` and pass it downstream.
- Add `testedLocally: boolean` to `PRTemplateInput` in `src/github/prTemplate.ts`.

*`src/review/humanGate.ts`*
- Add `[T]est locally` to the prompt line. When pressed, print the two git commands and wait for the user to press Enter before re-displaying the prompt. The branch and bound-repo URL are already in `ReviewPayload.result.outcome.branch` and `ReviewPayload.result.boundRepo`:
  ```
  git fetch https://github.com/{owner}/{name} {branch}
  git checkout FETCH_HEAD
  ```
  (`FETCH_HEAD` gives a detached HEAD that is sufficient for running tests; the operator is not expected to push from this state.)
- Track a `testedLocally` boolean (initially `false`; set to `true` after the user completes the `[T]` path). Pass it in the returned `{ action: 'approve', testedLocally }` decision.

*`src/github/prTemplate.ts`*
- When `testedLocally` is `true`, render: `"reviewed, tested locally, and approved by the author before submission."`
- When `false` (diff-only approval): `"reviewed and approved by the author before submission (changes were not run locally)."`

*Caller (`src/cli/runCommand.ts`)*
- Extract `testedLocally` from the `approve` decision and thread it into `createPR` / `renderPRBody`.

**Risks.**
- The operator might press `[T]`, see the commands, and then approve without actually running anything. This is unavoidable — patchwork cannot observe the other terminal. The feature shifts responsibility honestly: the operator is shown the path; if they skip it and approve, the PR body says so.
- `FETCH_HEAD` leaves a detached HEAD. Add a note in the printed output: `"To return to your previous branch: git checkout -"`.
- Web / Slack surfaces (v0.2+) cannot use this interactive path as designed. When those surfaces implement `present()`, they should render the git commands in the review UI and offer an explicit "I tested this" checkbox that gates the `testedLocally` flag. The `ReviewDecision` shape already carries the flag, so the PR template requires no further changes.

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

### Pluggable triage provider

**What.** Today `src/github/scoreIssue.ts` is bound to `@anthropic-ai/sdk` and `claude-haiku-4-5-20251001` per PLAN. Lift that into a small `TriageProvider` interface so operators can swap the triage backend (different Anthropic model, OpenAI, a local model, or a deterministic heuristic for offline/CI use) without touching the orchestrator.

**Why.** Cursor SDK is the agent runtime — provider-flexible by design. Triage was deliberately kept simple in v0.1 to ship the safety story first, but it is the second-largest cost line item per run and the most natural place to experiment with cheaper or fine-tuned models. A swappable interface unlocks that without a rewrite.

**What would be needed.**
- `interface TriageProvider { score(issue: IssueRef): Promise<{ score: TriageScore; tokens: TokenUsage; model: string }> }` exported from `src/github/triage/types.ts`.
- Move the current Anthropic-specific code into `src/github/triage/anthropic.ts` implementing the interface; the system prompt and tool schema stay where they are.
- Configuration: extend `Settings` schema with an optional `triage_provider` field (defaulting to `anthropic`); resolve to a concrete provider in the Phase 6 orchestrator.
- Update `MODEL_PRICES` only as needed — pricing is already centralised.

**Hard constraint.** Whichever provider is used, the system prompt **must** continue to reinforce invariant #6 (issue body is untrusted data, not instructions). The interface should accept a system-prompt template hook so this requirement is enforced uniformly across providers.

**Risks.**
- Cheap providers may fail JSON-mode contracts more often. The retry-once-then-SKIP behavior in v0.1 (invariant #5) must be preserved per provider.
- Provider drift in token-accounting fields (cache_read, cache_creation, etc.) — keep `TokenUsage` provider-agnostic; do mapping inside the provider implementation, never in the orchestrator.

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
