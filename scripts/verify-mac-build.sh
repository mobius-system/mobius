#!/usr/bin/env bash
# verify-mac-build.sh — macOS 桌面包发布前强制校验 (方案 §B3/§C1 验收)。
#
# electron-builder 在 Apple 凭据缺失时会【静默跳过】签名/公证且 exit 0, 故不能信构建日志。
# 本脚本独立复验: 真实 Developer ID 签名 + 公证票据 + 架构 + 内置 Python 可运行。任一不过即 exit 1,
# 阻止 CI 发布未签名/ad-hoc/架构错的包。
#
# 只能在 macOS 运行 (codesign/spctl/stapler/xcrun 为 mac 专属工具)。
#
# 用法:
#   scripts/verify-mac-build.sh <version> <arch> [release_dir]
#     version    桌面端版本号 (与 package.json 一致), 如 0.0.22
#     arch       arm64 | x64
#     release_dir electron-builder 产物目录 (默认 mobius/desktop/release)
#
# 环境:
#   APPLE_TEAM_ID  预期 TeamIdentifier (默认 6FMVHL6RLY)
set -euo pipefail

VERSION="${1:-}"
ARCH="${2:-}"
REL="${3:-mobius/desktop/release}"
EXPECTED_TEAM="${APPLE_TEAM_ID:-6FMVHL6RLY}"

# 颜色
G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[0m'
ok()   { echo "${G}✓ $1${D}"; }
fail() { echo "${R}✗ $1${D}"; FAILURES=$((FAILURES+1)); }
section() { echo "${Y}=== $1 ===${D}"; }
FAILURES=0

if [[ "$(uname)" != "Darwin" ]]; then
  echo "${R}verify-mac-build 只能在 macOS 运行 (当前 $(uname))${D}" >&2
  exit 2
fi
if [[ -z "$VERSION" || -z "$ARCH" ]]; then
  echo "用法: $0 <version> <arch:arm64|x64> [release_dir]" >&2
  exit 2
fi
# 支持 --selftest: 仅校验脚本本身可执行 + 依赖工具存在 (不跑真签名检查)。
if [[ "$1" == "--selftest" ]]; then
  for t in codesign spctl xcrun file; do command -v "$t" >/dev/null || { echo "✗ 缺工具 $t"; exit 1; }; done
  echo "✓ verify-mac-build 自检通过 (macOS 工具齐全)"; exit 0
fi

# 找 .app (electron-builder 默认放 release/mac-<arch>/ 下; 兼容 mac/ 等历史布局)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL_ABS="$REPO_ROOT/$REL"
[[ -d "$REL_ABS" ]] || REL_ABS="$REL"
APP="$(find "$REL_ABS" -maxdepth 3 -type d -name "Mobius Desktop.app" 2>/dev/null | head -n1 || true)"
if [[ -z "$APP" ]]; then
  echo "${R}✗ 未在 $REL_ABS 下找到 Mobius Desktop.app${D}" >&2
  echo "  release 实际内容:"; ls -la "$REL_ABS" 2>/dev/null || true
  exit 1
fi
echo "校验目标: $APP  (version=$VERSION arch=$ARCH team=$EXPECTED_TEAM)"

section "1/6 codesign --verify --deep --strict"
if codesign --verify --deep --strict --verbose=2 "$APP" >/tmp/vmb-csverify 2>&1; then
  ok "签名校验通过"
else
  fail "codesign --verify 失败:"; tail -n5 /tmp/vmb-csverify >&2
fi

section "2/6 签名身份 (须是 Developer ID Application, 非 ad-hoc)"
CS_DUMP="$(codesign -d --verbose=4 "$APP" 2>&1 || true)"
if echo "$CS_DUMP" | grep -q "Authority=Developer ID Application"; then
  ok "Authority 含 Developer ID Application"
else
  fail "Authority 不是 Developer ID Application (可能 ad-hoc/未签名):"; echo "$CS_DUMP" | grep -iE "Authority|Signature" >&2
fi
if echo "$CS_DUMP" | grep -q "TeamIdentifier=${EXPECTED_TEAM}"; then
  ok "TeamIdentifier = ${EXPECTED_TEAM}"
else
  fail "TeamIdentifier 不是 ${EXPECTED_TEAM}:"; echo "$CS_DUMP" | grep -i "TeamIdentifier" >&2
fi
if echo "$CS_DUMP" | grep -qiE "flags=.*adhoc|Identifier adhoc"; then
  fail "签名是 ad-hoc (正式包严禁)"
else
  ok "签名非 ad-hoc"
fi

section "3/6 Gatekeeper assessment (spctl accepted)"
if spctl --assess --type execute --verbose=4 "$APP" >/tmp/vmb-spctl 2>&1; then
  ok "spctl 通过"
else
  fail "spctl 未通过:"; cat /tmp/vmb-spctl >&2
fi

section "4/6 公证票据 (stapler validate)"
if xcrun stapler validate "$APP" >/tmp/vmb-stapler 2>&1; then
  ok "公证票据 staple 成功"
else
  fail "stapler validate 失败 (未公证或票据未 staple):"; cat /tmp/vmb-stapler >&2
fi

section "5/6 主程序架构 (${ARCH})"
MAIN_EXE="$APP/Contents/MacOS/Mobius Desktop"
if [[ "$ARCH" == "arm64" ]]; then WANT="arm64"; else WANT="x86_64"; fi
if [[ -f "$MAIN_EXE" ]] && file "$MAIN_EXE" | grep -q "$WANT"; then
  ok "主程序架构 = $WANT"
else
  fail "主程序架构不符 $WANT:"; file "$MAIN_EXE" 2>/dev/null >&2 || echo "  $MAIN_EXE 不存在" >&2
fi

section "6/6 内置 Python 架构一致 + 可启动"
# 兼容单层 resources/python/bin/python3 与双层 resources/python/python/bin/python3
PY="$(find "$APP/Contents/Resources" -maxdepth 4 -type f -name python3 2>/dev/null | head -n1 || true)"
if [[ -z "$PY" ]]; then
  PY="$(find "$APP/Contents/Resources" -maxdepth 5 -type f \( -name python3 -o -name python \) 2>/dev/null | head -n1 || true)"
fi
if [[ -n "$PY" ]]; then
  if file "$PY" | grep -q "$WANT"; then ok "内置 Python 架构 = $WANT"; else fail "内置 Python 架构不符 $WANT:"; file "$PY" >&2; fi
  if "$PY" --version >/tmp/vmb-pyver 2>&1; then ok "内置 Python 可启动: $(cat /tmp/vmb-pyver)"; else fail "内置 Python --version 失败:"; cat /tmp/vmb-pyver >&2; fi
else
  fail "未找到内置 Python 解释器 (Contents/Resources/python/...)"
fi

echo
if [[ "$FAILURES" -gt 0 ]]; then
  echo "${R}========================================${D}"
  echo "${R}✗ 校验失败 $FAILURES 项 —— 禁止发布该包${D}"
  echo "${R}========================================${D}"
  exit 1
fi
echo "${G}========================================${D}"
echo "${G}✓ 全部 6 项校验通过 —— 包可用于正式发布${D}"
echo "${G}========================================${D}"

# 顺带打印 dmg/zip 的 size + sha256, 供 manifest 登记 (CI release job 用)。
echo
section "产物 size + sha256 (供 manifest)"
for ext in dmg zip; do
  F="$REL_ABS/mobius-desktop-${VERSION}-mac-${ARCH}.${ext}"
  [[ -f "$F" ]] || F="$REL_ABS/Mobius Desktop-${VERSION}-mac-${ARCH}.${ext}"
  if [[ -f "$F" ]]; then
    printf "  %s  %s bytes  sha256=%s\n" "$(basename "$F")" "$(stat -f%z "$F")" "$(shasum -a 256 "$F" | cut -d' ' -f1)"
  fi
done
exit 0
