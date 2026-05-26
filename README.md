# patchwork

> An autonomous open-source contribution agent. You stay the author. The AI is the tool.

Patchwork scans GitHub repositories for open issues, triages them with a cheap LLM, and dispatches Cursor SDK cloud agents to attempt fixes. Every fix lands in your terminal for review. Only after **you** approve does a PR appear on GitHub — submitted from your account, with a clear AI-disclosure block in the body.

It is built for the contributor who wants leverage over open source, not a black-box bot that posts AI-generated PRs while you sleep.

---

## Why patchwork exists

Most "AI contribution" tools optimise for volume and run unattended. That's a recipe for noise: maintainers get spammed with low-quality PRs, contributors lose track of what they're claiming as their own work, and trust in OSS erodes.

Patchwork inverts the trade-off. The expensive, slow steps — fetching issues, scoring them, running agents — are automated. The cheap, fast step — a human looking at a diff and saying yes or no — is mandatory. The result is fewer, better PRs that you genuinely understand and stand behind.

---

## Core principles

| Principle | What it means in practice |
|---|---|
| **Human review is non-negotiable** | No PR is created without explicit approval of the diff. There is no "auto" mode, even in CI. Non-interactive environments either run in dry-run or refuse to run. |
| **AI involvement is disclosed** | Every PR body contains a standardised disclosure block. There is no flag to suppress it. |
| **Cost is observable and capped** | Token usage and USD cost are reported per issue and aggregated per run. A configurable limit aborts the run gracefully. |
| **Failure mode is SKIP** | When the agent isn't confident, the issue is skipped with a logged reason — never silently retried, never papered over with a low-quality PR. |
| **Models are configurable, not hardcoded** | Pick `composer-2` for batch economics, frontier models for hard issues, all per-target. |

---

## How it works

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Fetch issues │ -> │ Triage with  │ -> │ Run Cursor   │ -> │ Render diff  │
│ from GitHub  │    │ Claude Haiku │    │ cloud agent  │    │ in terminal  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────┬───────┘
                                                                   │
                                                       ┌───────────▼───────────┐
                                                       │  You approve / reject │
                                                       │   / skip / open in    │
                                                       │        browser        │
                                                       └───────────┬───────────┘
                                                                   │ approve
                                                       ┌───────────▼───────────┐
                                                       │  Create PR via your   │
                                                       │  GitHub account, with │
                                                       │  AI disclosure block  │
                                                       └───────────────────────┘
```

1. **Fetch.** Octokit pulls open issues from each configured target, filtered by labels and metadata (no PRs masquerading as issues, no assigned issues, no `wontfix`/`duplicate`/`question`/`needs-design`, no empty bodies, no contentious threads above the comment threshold).
2. **Triage.** Claude Haiku scores each surviving issue 0–10 against a four-axis rubric (clarity, scope, context, viability). Only issues at or above the threshold proceed.
3. **Dedupe.** Patchwork checks for existing open PRs that reference the issue. If one exists, the issue is skipped.
4. **Bind.** If you don't own the upstream repo, patchwork ensures a fork exists in your account and binds the Cursor agent to the fork. Cursor's cloud agent is permanently linked to its target repo, so this happens fresh per issue.
5. **Run.** A Cursor cloud agent attempts the fix on a new branch. Token usage is streamed live via `onStep`/`onDelta` events.
6. **Review.** Patchwork fetches the unified diff, renders it in your terminal with file/line counts and a cost summary, and prompts: approve / reject / skip / open in browser. **PRs are only created on approve.**
7. **Submit.** Octokit opens the PR from your fork (or directly, if you own upstream) with the standardised disclosure block. The branch already lives in the right place — there is no separate push step.

---

## Quickstart

### Prerequisites

- Node.js 22 or newer
- An interactive terminal (patchwork refuses to run unattended)
- API credentials:
  - `GITHUB_TOKEN` — a personal access token with `repo` scope, from the account you want to author PRs
  - `ANTHROPIC_API_KEY` — for the Haiku triage step
  - `CURSOR_API_KEY` — for the Cursor SDK

### GitHub token setup

Patchwork needs a GitHub Personal Access Token (PAT) to read issues, fork repos, and open PRs under your account. Two token types are supported.

---

#### Option A — Fine-grained PAT (recommended)

Fine-grained tokens are more auditable and follow the principle of least privilege.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Set an expiration (90 days is a reasonable default).
3. Under **Repository access**, choose **All repositories** (patchwork targets repos you don't own, so you cannot enumerate them upfront).
4. Under **Permissions → Repository permissions**, grant:

| Permission | Access | Why |
|---|---|---|
| **Contents** | Read and write | Read code; push branches to your fork |
| **Issues** | Read-only | Fetch and read issue bodies |
| **Metadata** | Read-only | Required for all fine-grained tokens |
| **Pull requests** | Read and write | Check for existing PRs (dedup); open the final PR |

> **Note on forking.** Forking a repo you don't own creates a new repo in _your_ account. The fork itself is created via the Issues/Contents APIs on the upstream side (read-only) and lands in your account. No extra permission beyond the four above is required.

5. Click **Generate token** and copy the value to `GITHUB_TOKEN`.

---

#### Option B — Classic PAT

Simpler to set up, broader in scope.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**.
2. Choose an expiration.
3. Select scopes:
   - **`public_repo`** — sufficient if you only target public repositories (most open-source contribution workflows).
   - **`repo`** — required if any target is a private repository (grants full read/write on all your repos).
4. Click **Generate token** and copy the value to `GITHUB_TOKEN`.

---

#### Which to use?

Use a fine-grained PAT unless your targets include private repos that belong to organisations where fine-grained tokens are disabled by the org admin. Classic PATs with `repo` scope are equivalent in power to your full GitHub account — treat them accordingly.

---

### Install

```bash
npm install -g patchwork
```

Or, from source:

```bash
git clone https://github.com/<your-org>/patchwork.git
cd patchwork
npm install
npm run build
npm link
```

### Configure

Copy `examples/minimal.yaml` to `config/targets.yaml` and edit:

```yaml
targets:
  - repo: facebook/react
    labels: [bug, "good first issue"]
    max_issues: 3
    model: composer-2

settings:
  min_score: 7
  cost_limit_usd: 1.50
  dry_run: false
```

Set environment variables (a `.env` file in the project root works, or export directly):

```bash
export GITHUB_TOKEN=ghp_...
export ANTHROPIC_API_KEY=sk-ant-...
export CURSOR_API_KEY=...
```

### Run

```bash
# Triage only — score issues, write a report, no agents and no cost beyond Haiku
patchwork triage

# Estimate cost for the current config without running anything
patchwork cost

# Full run — triage, dispatch agents, prompt for review on each fix
patchwork run

# Limit a run to a single target
patchwork run --repo facebook/react

# Re-review issues you previously chose to skip
patchwork review
```

---

## Configuration reference

### `config/targets.yaml`

```yaml
targets:
  - repo: owner/name              # required
    labels: ["bug"]               # optional; AND logic across labels
    max_issues: 5                 # max issues attempted per target per run (default 5)
    max_tokens_per_issue: 150000  # safety cap on agent run length (default 150k)
    skip_if_comments_gt: 30       # drop contentious threads (default 30)
    model: composer-2    # see "Choosing a model" below

settings:
  mode: sequential                # only sequential in v0.1 (parallel is roadmap)
  dry_run: false                  # true = triage and score, no agents, no PRs
  min_score: 7                    # global triage threshold (0..10, default 7)
  cost_limit_usd: 2.00            # abort run after current issue if exceeded
```

Unknown keys are rejected. Validation errors include the offending path (e.g. `targets[1].max_issues`) and the reason.

### Triage rubric

Claude Haiku scores each issue on:

| Axis | Range | Question |
|---|---|---|
| Clarity | 0–3 | Is the problem clearly described with reproduction steps? |
| Scope | 0–3 | Is this a contained fix, not an architecture or feature ask? |
| Context | 0–2 | Is there enough code context, error output, or repro? |
| Viability | 0–2 | Can this likely be fixed without maintainer input? |

Total is 0–10. Default threshold is 7. Issues are also filtered (regardless of score) if they are: PRs in disguise, assigned, labelled `needs-design` / `wontfix` / `duplicate` / `question`, empty-bodied, or above the comment threshold.

### Choosing a model

Patchwork is a **batch** workflow — every issue is a fresh isolated run, latency is not a constraint, and runs happen in the background while you do something else. That makes Cursor's Standard variant the right default.

| Model | Input / 1M | Output / 1M | Cache read / 1M | When to use |
|---|---|---|---|---|
| `composer-2` | $0.50 | $2.50 | $0.20 | **Default.** Routine bug fixes, batch-friendly. |
| `composer-2-fast` | $1.50 | $7.50 | $0.35 | Latency-sensitive interactive sessions (rare in patchwork). |
| `claude-sonnet-4-6` | $3.00 | $15.00 | $0.30 | Issues triage flags as `escalate` — moderate complexity. |
| `claude-opus-4-7` | $5.00 | $25.00 | $0.50 | High-stakes contributions where you want the strongest reasoning. |

Cost is tracked exactly via Cursor's `onStep` / `onDelta` event streams — there is no estimation layer.

If you write `model: composer-2` (without a variant) in YAML, patchwork warns and resolves it to `composer-2`.

---

## The PR template

Every patchwork PR body has this shape:

```markdown
Fixes #<N>

## What was changed and why

<agent-generated summary>

## Testing notes

<agent-generated, or "No automated tests were detected or run." if absent>

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation update

## AI Disclosure

This contribution was developed with AI assistance using the Cursor SDK
(<model> model). All code changes were reviewed, tested, and approved
by the author before submission.

---
*Submitted via patchwork.*
```

The disclosure block is mandatory and tested for. There is no flag to remove it.

---

## CLI commands

| Command | What it does |
|---|---|
| `patchwork run` | Full pipeline: triage, dispatch agents, prompt for review, create PRs on approval |
| `patchwork triage` | Score issues only. Writes `.patchwork/TRIAGE.md`. No agents, no PRs. |
| `patchwork review` | Re-open the deferred-review queue from previous runs |
| `patchwork cost` | Estimate worst-case cost for the current config |

Common flags:

- `-c, --config <path>` — path to `targets.yaml` (default `config/targets.yaml`)
- `--dry-run` — score only, never call Cursor or create PRs
- `--repo <owner/name>` — limit the run to one target

---

## Cost controls

- `cost_limit_usd` is a **hard cap.** The current agent run finishes (Cursor agents are durable; killing them mid-run is wasteful), then the run aborts. The `SUMMARY.md` reports `costLimitHit: true`.
- Haiku triage is included in the budget.
- Use `patchwork cost` before a run to see worst-case projection.
- Cache-read tokens are billed at their lower rate when the model exposes it (Cursor models do).

---

## Troubleshooting

**`patchwork run requires an interactive terminal …`**
You are running in CI, a Docker container without `-it`, or a non-TTY shell. Use `--dry-run` for non-interactive triage. Full runs intentionally refuse to operate without a human.

**`ForkConflictError: a repo named X already exists in your account but it is not a fork of Y`**
Patchwork won't push agent branches into an unrelated repo of the same name. Rename or archive the conflicting repo, then retry.

**Branches showing up in upstream rather than my fork**
Your `GITHUB_TOKEN` belongs to an account with push access to the upstream repo, so patchwork bound the agent there. For fork-style workflow, use a token from your contributor account, not your maintainer account.

**`Unknown model: <name>` warning**
Cost reporting will show $0 for runs on that model. Add the rate to `src/reporter/costs.ts` or open an issue.

**Agent produced no diff**
Treated as `SKIP`. Logged in `SUMMARY.md`, no review prompt, no PR.

**Network dropped mid-run**
Cursor cloud agents are durable. Patchwork checkpoints the run id and event cursor; restart the command and it resumes the in-flight run from the last event.

---

## Project layout

```
patchwork/
├── src/
│   ├── main.ts                 # CLI entrypoint
│   ├── cli/                    # commander commands + preflight
│   ├── config/                 # YAML loader, Zod schema, defaults
│   ├── github/                 # Octokit, fetch, score, dedup, fork, PR creation
│   ├── agent/                  # Cursor SDK wrapper, prompt, run orchestration
│   ├── review/                 # Diff viewer, terminal review surface, deferred queue
│   ├── reporter/               # Cost table, run state, console + markdown reporters
│   └── types.ts                # Shared domain types
├── config/targets.yaml         # User-editable starter config
├── examples/                   # Reference configs
├── .cursor/skills/             # OSS contribution norms taught to the agent
├── PLAN.md                     # Phased implementation plan
└── FUTURE.md                   # Deferred-feature roadmap
```

The implementation plan is in [PLAN.md](./PLAN.md). Read it before contributing — every file path and contract is intentional.

---

## Roadmap

Detailed in [FUTURE.md](./FUTURE.md). High-level shape:

- **v0.2** — web dashboard with kanban and browser diff viewer; parallel agent execution; webhook / CI trigger mode (triage-only, still no auto-PR).
- **v0.3** — multi-repo campaigns; learning loop that feeds merge/close outcomes back into triage; alternative review surfaces (Slack, Telegram).

The v0.1 architecture is built so none of these require core rewrites. `ReviewSurface` is a strategy interface; `RunState` is mutex-safe; the cost table is centralised; the Cursor SDK is isolated behind one client module.

---

## Contributing

Patchwork is itself a small open-source project. Contributions are welcome — and yes, you can use patchwork to contribute to patchwork, provided every PR still goes through the human review gate. Treat the disclosure block as mandatory; do not add flags to suppress it.

Run the test suite locally with `npm test`. **CI** (`.github/workflows/ci.yml`) runs test, lint, and typecheck on pull requests. **Invariant Audit** (`.github/workflows/invariant-audit.yml`) runs the trusted `scripts/invariant-audit.mjs` checker from base-branch workflow logic via `pull_request_target` — add that check as a required status check in branch protection. Local edits use `.claude/hooks/invariant-audit.sh` (keep in sync with the script).

---

## License

MIT. See [LICENSE](./LICENSE).
