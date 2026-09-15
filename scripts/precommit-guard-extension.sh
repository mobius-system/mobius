#!/usr/bin/env bash
set -eu
bad=$(git diff --cached --name-only --diff-filter=ACMR | awk '/^mobius\/extension\// {print}')
if [ -n "$bad" ]; then
  echo "ERROR: mobius/extension is ignored and must never be committed:" >&2
  echo "$bad" >&2
  echo "Do not use git add -f or bypass pre-commit." >&2
  exit 1
fi
