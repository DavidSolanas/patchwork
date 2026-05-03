#!/usr/bin/env bash
# Blocks Bash commands that target .env files (secrets leak prevention).

command=$(cat | grep -o '"command"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//')

if echo "$command" | grep -q '\.env' && ! echo "$command" | grep -q '\.env\.example'; then
  echo "BLOCKED: Command targets a .env file. Inspect secrets manually." >&2
  exit 2
fi

exit 0
