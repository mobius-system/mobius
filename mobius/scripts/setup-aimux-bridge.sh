#!/usr/bin/env bash
# Create or refresh mobius/.venv-aimux with aimux==0.1.8 from PyPI.
# Idempotent: skips install when aimux of the right version is already on disk.
# Used by start_product.py / Dockerfile.
set -euo pipefail

MOBIUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${AIMUX_VENV:-$MOBIUS_DIR/.venv-aimux}"
AIMUX_VERSION="${AIMUX_VERSION:-0.1.8}"
UV_BIN="${UV_BIN:-uv}"

need_install=1
if [[ -x "$VENV_DIR/bin/aimux" ]]; then
  # uv venv 默认不装 pip, 直接读 dist-info 目录拿版本号
  dist_info="$(ls -d "$VENV_DIR"/lib/python*/site-packages/aimux-*.dist-info 2>/dev/null | head -n1 || true)"
  if [[ -n "$dist_info" ]]; then
    installed="$(basename "$dist_info" | sed -n 's/^aimux-\(.*\)\.dist-info$/\1/p')"
    if [[ "$installed" == "$AIMUX_VERSION" ]]; then
      need_install=0
    fi
  fi
fi

if [[ $need_install -eq 0 ]]; then
  echo "[setup-aimux-bridge] aimux==$AIMUX_VERSION already installed at $VENV_DIR"
  exit 0
fi

echo "[setup-aimux-bridge] creating venv at $VENV_DIR"
UV_VENV_CLEAR=1 "$UV_BIN" venv "$VENV_DIR" --python 3.12

echo "[setup-aimux-bridge] installing aimux==$AIMUX_VERSION"
install_args=(pip install --python "$VENV_DIR" --index-url https://pypi.org/simple/ "aimux==$AIMUX_VERSION")
# In Docker build (no proxychains in PATH), the env may pre-set http_proxy via build args.
# On host we expect callers to wrap with proxychains if PyPI is slow.
if command -v proxychains >/dev/null 2>&1 && [[ -z "${AIMUX_NO_PROXYCHAINS:-}" ]]; then
  proxychains "$UV_BIN" "${install_args[@]}"
else
  "$UV_BIN" "${install_args[@]}"
fi

echo "[setup-aimux-bridge] done: $VENV_DIR/bin/aimux"
