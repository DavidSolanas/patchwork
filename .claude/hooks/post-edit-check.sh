#!/usr/bin/env bash
# Run typecheck + lint after edits to TypeScript files under src/.
# Skips work for edits to non-src/.ts files (config, docs, etc.).
# Exit 2 = block, surfacing the error to Claude.

set -uo pipefail

input=$(cat)

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0
[ -d src ] || exit 0

file_path=""
if command -v jq >/dev/null 2>&1; then
  file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
fi

# Only act on src/**/*.ts edits. If we couldn't extract the path, run anyway —
# the cost of an extra typecheck is small.
if [ -n "$file_path" ]; then
  case "$file_path" in
    *.ts) ;;
    *) exit 0 ;;
  esac
  case "$file_path" in
    *src/*|src/*) ;;
    *) exit 0 ;;
  esac
fi

# Project-wide typecheck — required because TS resolves imports across files.
if ! out=$(npx --no-install tsc --noEmit 2>&1); then
  echo "TypeScript errors:" >&2
  echo "$out" >&2
  exit 2
fi

# Lint the changed file (or the whole src/ if we couldn't determine the file).
target="${file_path:-src}"
if ! out=$(npx --no-install eslint "$target" 2>&1); then
  echo "ESLint errors in $target:" >&2
  echo "$out" >&2
  exit 2
fi

exit 0
