---
name: phase-advance
description: Walk through the next implementation phase from PLAN.md — load the phase contract, scaffold the listed files in the prescribed order, write tests alongside, and verify invariants and the test suite pass before declaring the phase complete. Phase ordering is load-bearing, so use this skill instead of free-handing phase transitions.
disable-model-invocation: true
---

# Phase advance

Patchwork is built phase-by-phase per `PLAN.md`. Phase ordering matters:

- Phase 2 (review gate) must come before Phase 3 (agent integration) — the gate is the safety net.
- `forkRepo.ts` is listed under Phase 4 in the file layout but is implemented during Phase 3 (binding).
- `FUTURE.md` lists features intentionally deferred from v0.1; do not implement them here.

Use this skill to advance to the next phase deliberately. Do not skip steps.

## Inputs

The user invokes this skill with a phase number (e.g. `/phase-advance 1`). If they don't, ask which phase before doing anything.

## Procedure

1. **Read the spec.** Open `PLAN.md` and find § "Phase N". Read it in full. Read the phase before and after as well — context matters.
2. **Read invariants.** Open `CLAUDE.md` § "Non-negotiable invariants". Identify which invariants are most relevant to this phase (e.g., #1 and #4 dominate Phase 4; #3 dominates Phase 2; #6 dominates Phase 3).
3. **List the deliverables.** From the PLAN.md phase section, list the file paths, type signatures, and contracts to be produced. Confirm with the user before writing code — do not surprise them with files they didn't expect.
4. **Scaffold in order.** Create files in the order they appear in PLAN.md. Type signatures and contracts in PLAN.md are binding — copy them exactly, do not "improve" them.
5. **Test as you go.** For each new module, write a vitest test alongside it (`src/<area>/__tests__/<name>.test.ts`). The phase isn't done until tests pass.
6. **Verify before declaring done.** Run, in this order, and resolve every failure:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   The invariant-audit hook runs the three CI greps automatically on each edit; if it has been firing clean throughout, you are good. If unsure, run `bash .claude/hooks/invariant-audit.sh` manually.
7. **Spawn `invariant-reviewer`.** Once tests pass, dispatch the `invariant-reviewer` subagent on `git diff main...HEAD` for an independent verdict. Do not ship the phase if it returns FAIL.
8. **Update CLAUDE.md "Repository state".** When the phase is complete, edit the "Repository state" paragraph in CLAUDE.md to reflect what now exists. Do not advertise phases that aren't fully implemented.
9. **Stop.** Do not begin Phase N+1 in the same session. Phase transitions are deliberate; the user starts the next one explicitly.

## Things to refuse

- Implementing anything in `FUTURE.md` § "Architecture commitments preserved for the future" — those are deferred.
- Skipping ahead (e.g., touching `src/github/createPR.ts` during Phase 1).
- Loosening any of the 10 invariants for "convenience" during scaffolding.
- Phase 3 work without Phase 2 already merged and tested.

If `PLAN.md` and the user's request conflict, the user must reconcile in `PLAN.md` first — do not silently deviate from the spec.

## Phase-specific reminders

- **Phase 1 (GitHub triage):** `fetchIssues`/`findExistingPR`/`scoreIssue` only. Three dedup checkpoints (pre-triage, pre-agent, pre-PR) start being wired here — invariant #7.
- **Phase 2 (review gate):** Build `ReviewSurface` interface, `TerminalReviewSurface`, `humanGate.ts`. Harden against fixtures before any Cursor SDK code is touched. Invariant #8 forbids the orchestrator from importing `humanGate` directly.
- **Phase 3 (agent integration):** Two cooperative loops (event consumer + status poller) against the Cursor SDK. Checkpoint to `.patchwork/state.json` immediately after `startRun`. `forkRepo.ts` is implemented here despite living under Phase 4 in the layout. Spawn `prompt-injection-reviewer` once a triage prompt exists.
- **Phase 4 (PR creation):** `src/github/createPR.ts` is the single allowed caller of `octokit.pulls.create` (invariant #1). PR template includes the disclosure block (invariant #4) — write the unit test for the substring at the same time.
- **Phase 5+ (reporter, CLI):** Wire `RunState.shouldAbortBeforeNextRun()` into the orchestrator (invariant #9). Exhaustive `ReviewDecision` switching with `const _: never` (invariant #10). Non-TTY full runs must refuse to start (invariant #3).
