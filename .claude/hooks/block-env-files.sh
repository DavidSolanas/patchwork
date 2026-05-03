#!/usr/bin/env bash
# Blocks Read/Edit/Write/MultiEdit tool calls targeting .env files (secrets leak prevention).

file_path=$(cat | grep -o '"file_path"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//')

if [[ -n "$file_path" ]]; then
  basename=$(basename "$file_path")
  if [[ "$basename" == ".env" || "$basename" == .env.* || "$basename" == *.env ]] && [[ "$basename" != ".env.example" ]]; then
    echo "BLOCKED: .env files are off-limits to prevent accidental key exposure. Access '$file_path' manually." >&2
    exit 2
  fi
fi

exit 0
