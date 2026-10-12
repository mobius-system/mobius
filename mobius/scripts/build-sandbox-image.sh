#!/usr/bin/env bash
# 构建普通用户沙箱容器镜像 (USER_ISOLATION_DOCKER_IMAGE 指向的 tag).
# 用法: scripts/build-sandbox-image.sh [tag]   (默认 mobius-system-sbx:latest)
# 构建上下文 = 仓库根 (只 COPY deploy/claude 与 deploy/codex 两个模板目录, 无源码无 .env).
set -euo pipefail

TAG="${1:-mobius-system-sbx:latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # mobius/
CONTEXT="$(cd "$ROOT/.." && pwd)"                          # 仓库根

echo "[build-sandbox-image] building $TAG from $CONTEXT"
docker build -f "$CONTEXT/deploy/Dockerfile.sbx" -t "$TAG" "$CONTEXT"

# 断言: 镜像层里不许出现仓库源码与敏感物 (整洁性守卫)
echo "[build-sandbox-image] verifying layers..."
if docker history "$TAG" --format '{{.CreatedBy}}' | grep -qE 'COPY \.? ?/?(app_image|mobs|mobius) '; then
  echo "[build-sandbox-image] FAIL: 镜像含仓库源码 COPY" >&2; exit 1
fi
if docker history "$TAG" --format '{{.CreatedBy}}' | grep -qE '\.env|protected_data'; then
  echo "[build-sandbox-image] FAIL: 镜像疑似含敏感文件" >&2; exit 1
fi
echo "[build-sandbox-image] OK: $TAG"
docker image inspect "$TAG" --format 'size={{.Size}}'
