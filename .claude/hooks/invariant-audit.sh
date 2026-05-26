#!/usr/bin/env bash
# Patchwork invariant audit — mirrors scripts/invariant-audit.mjs, which
# .github/workflows/invariant-audit.yml runs from trusted base-branch code
# during pull_request_target. Documented in CLAUDE.md
# § "CI audit checks (load-bearing)". Runs after every Edit/Write/MultiEdit so
# violations are caught at edit time, not only in CI.
#
# Test files are excluded (they may legitimately mock octokit.pulls.create or
# import @octokit/rest), matching the exception in .eslintrc.cjs.
#
# Exit 2 = block (Claude sees stderr and must fix before continuing).

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0
[ -d src ] || exit 0

if ! node scripts/invariant-audit.mjs . >&2; then
  echo "See CLAUDE.md § 'Non-negotiable invariants' before continuing." >&2
  exit 2
fi

exit 0
