#!/usr/bin/env bash
# Patchwork invariant audit — mirrors the inline grep checks in .github/workflows/ci.yml
# (CI must not execute this file from a PR checkout). Documented in CLAUDE.md
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

violations=0

check() {
  local label="$1"
  local hits="$2"
  if [ -n "$hits" ]; then
    echo "❌ $label" >&2
    echo "$hits" | sed 's/^/   /' >&2
    violations=$((violations + 1))
  fi
}

# 1. octokit.pulls.create outside src/github/createPR.ts
hits=$(grep -rEn 'octokit\.pulls\.create' src --include='*.ts' 2>/dev/null \
  | grep -v '/__tests__/' \
  | grep -v '\.test\.ts:' \
  | grep -v '^src/github/createPR\.ts:' || true)
check "INVARIANT #1: octokit.pulls.create found outside src/github/createPR.ts" "$hits"

# 2. autoCreatePR: true anywhere
hits=$(grep -rEn 'autoCreatePR[[:space:]]*:[[:space:]]*true' src --include='*.ts' 2>/dev/null || true)
check "INVARIANT #2: autoCreatePR: true is forbidden (must be the literal false)" "$hits"

# 3. @octokit/rest imports outside src/github/**
hits=$(grep -rEn "from[[:space:]]+['\"]@octokit/rest['\"]" src --include='*.ts' 2>/dev/null \
  | grep -v '/__tests__/' \
  | grep -v '\.test\.ts:' \
  | grep -v '^src/github/' || true)
check "INVARIANT #3: @octokit/rest imported outside src/github/**" "$hits"

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "Patchwork invariant violations: $violations." >&2
  echo "See CLAUDE.md § 'Non-negotiable invariants' before continuing." >&2
  exit 2
fi

exit 0
