#!/usr/bin/env bash
set -euo pipefail

for js_file in "$@"; do
  if [[ "$js_file" == mobius/extension/*/frontend/*.js ]]; then
    node --input-type=module --check < "$js_file"
  else
    node --check "$js_file"
  fi
done
