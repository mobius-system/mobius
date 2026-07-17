#!/usr/bin/env bash
#
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/imac-user-bundle-$(date +%Y%m%d-%H%M%S).zip"
DATA_ROOT="${MOBIUS_DATA_PATH:-$ROOT/data}"
DB="${DB_PATH:-$DATA_ROOT/mobuis.db}"
PROTECTED="${CORE_DATA_PATH:-$ROOT/protected_data}"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --no-password) EXTRA_ARGS+=(--no-password); shift;;
    --users) EXTRA_ARGS+=(--users "$2"); shift 2;;
    --db) EXTRA_ARGS+=(--db "$2"); shift 2;;
    --protected) EXTRA_ARGS+=(--protected "$2"); shift 2;;
    -h|--help) sed -n '1,12p' "$0"; exit 0;;
    *) echo "unknown arg: $1"; exit 2;;
  esac
done

STAGING="$(mktemp -d -t imac-bundle-XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

cd "$ROOT/mobius"
EXTRA_ARGS+=(--staging "$STAGING")
node scripts/imac-export.js \
  --db "$DB" \
  --protected "$PROTECTED" \
  "${EXTRA_ARGS[@]}"

cd "$STAGING"
python3 -c "
import zipfile, os, sys
with zipfile.ZipFile('$OUT', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk('.'):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.relpath(full, '.')
            z.write(full, arc)
print('[zip] wrote', '$OUT')
"

ls -lh "$OUT"
echo "[export] DONE -> $OUT"
