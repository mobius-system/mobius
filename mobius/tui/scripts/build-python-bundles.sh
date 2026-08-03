#!/usr/bin/env bash
# 打包 TUI Plan B 用的 "python + aimux" 离线运行时 zip（linux-x64 / win-x64 / mac-x64）。
#
# 基础: python-build-standalone (CPython 3.12.7, tag 20241002), 自带完整 ensurepip+pip。
# aimux 及其依赖 (click/loguru/typer/rich) 全为纯 Python → linux 上一次 pip install 产出的
# 代码三平台通吃。win/mac 通过 `pip install --target` 把纯 python 轮子跨装进各自 site-packages。
# 跨装坑: click 在 Windows 依赖 colorama (marker platform_system==Windows), linux 上 pip 会漏,
# 故 win 目标显式补 colorama。
#
# 产物: <DIST>/mobius-python-<arch>-v<BUNDLE_VER>.zip  (zip 内根目录为 python/)
# TUI 端 URL 默认指向 mobius CDN, 可用 MOBIUS_TUI_PYTHON_BUNDLE_URL 覆盖。
set -euo pipefail

TAG=20241002
PYVER=3.12.7
BUNDLE_VER=1
WORK="${WORK:-/home/tianyi/python-bundles}"
DIST="${DIST:-$WORK/dist}"
mkdir -p "$WORK" "$DIST"

base="https://github.com/astral-sh/python-build-standalone/releases/download/$TAG"
# install_only_stripped = 去掉静态库 libpython.a / debug 符号, 专为分发瘦身 (运行 Python 应用无影响)
declare -A URLS=(
  [linux-x64]="$base/cpython-${PYVER}+${TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
  [win-x64]="$base/cpython-${PYVER}+${TAG}-x86_64-pc-windows-msvc-shared-install_only_stripped.tar.gz"
  [mac-x64]="$base/cpython-${PYVER}+${TAG}-x86_64-apple-darwin-install_only_stripped.tar.gz"
)

# 运行 `python -m aimux` 用不到的部分: 静态库/构建脚本/idle/tk/ensurepip 内置 wheel/缓存
prune() { # prune <python-root>
  local root=$1
  rm -rf "$root"/lib/python*/config-* "$root"/lib/python*/test "$root"/lib/python*/idlelib \
         "$root"/lib/python*/tkinter "$root"/lib/python*/turtledemo "$root"/lib/python*/ensurepip/_bundled \
         "$root"/lib/python*/site-packages/pip* "$root"/lib/python*/site-packages/setuptools* "$root"/lib/python*/site-packages/pkg_resources* \
         "$root"/Lib/config "$root"/Lib/test "$root"/Lib/idlelib "$root"/Lib/tkinter "$root"/Lib/turtledemo \
         "$root"/Lib/ensurepip/_bundled \
         2>/dev/null || true
  find "$root" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$root" -name '*.pyc' -delete 2>/dev/null || true
  rm -f "$root"/bin/2to3* "$root"/bin/idle* "$root"/bin/pydoc* "$root"/bin/*-config \
        "$root"/Scripts/2to3* "$root"/Scripts/idle* "$root"/Scripts/pydoc* 2>/dev/null || true
}

# 也许需要代理拉 github / pypi; 命令行无代理时直接跑, 失败再换 proxychains
dl() { # dl <url> <out>
  if command -v proxychains4 >/dev/null 2>&1 && [ "${USE_PROXY:-1}" = 1 ]; then
    proxychains4 -q curl -fL "$1" -o "$2"
  else
    curl -fL "$1" -o "$2"
  fi
}
pip() { command pip "$@"; }

echo "== 1) 下载并解压 python-build-standalone =="
for arch in linux-x64 win-x64 mac-x64; do
  if [ -x "$WORK/$arch/python/bin/python3" ] || [ -f "$WORK/$arch/python/python.exe" ]; then
    echo "  [$arch] 已存在, 跳过下载"; continue
  fi
  echo "  [$arch] 下载 ${URLS[$arch]}"
  dl "${URLS[$arch]}" "$WORK/$arch.tar.gz"
  mkdir -p "$WORK/$arch"
  tar -xzf "$WORK/$arch.tar.gz" -C "$WORK/$arch"
done

LINUX_PY="$WORK/linux-x64/python/bin/python3"
echo "== 2) linux-x64: 原生 pip install aimux =="
USE_PROXY=1 $LINUX_PY -m pip install --quiet aimux colorama || \
  $LINUX_PY -m pip install aimux colorama
echo "  验证: $($LINUX_PY -c 'import aimux, click, loguru, typer, rich; print("linux import ok", aimux.__name__)')"

echo "== 3) win-x64 / mac-x64: 跨装纯 python aimux 到各自 site-packages =="
# win: click 需 colorama; mac: 不需要 colorama
install_target() { # arch site_packages_dir [extra...]
  local arch=$1 sp=$2; shift 2
  echo "  [$arch] pip install --target $sp aimux $*"
  rm -rf "$sp"/* 2>/dev/null || true   # 重复构建时清旧
  USE_PROXY=1 $LINUX_PY -m pip install --quiet --target "$sp" aimux "$@" || \
    $LINUX_PY -m pip install --target "$sp" aimux "$@"
  echo "  [$arch] site-packages:"; ls "$sp" | head -20
}
install_target win-x64  "$WORK/win-x64/python/Lib/site-packages"            colorama
install_target mac-x64  "$WORK/mac-x64/python/lib/python3.12/site-packages"

echo "== 4) 瘦身 (删运行时用不到的 test/idle/tk/ensurepip wheel/缓存) 后打 zip =="
for arch in linux-x64 win-x64 mac-x64; do prune "$WORK/$arch/python"; done
# 本机无 zip 命令 → 用 python 造一个等价 -ry 的打包器: external_attr 存 st_mode,
# 符号链接存为 link-target + S_IFLNK 位, extract-zip 据此还原 symlink 与可执行位。
zip_py="$(mktemp).py"
cat > "$zip_py" <<'PYEOF'
import os, sys, stat, zipfile
src, out = sys.argv[1], sys.argv[2]
parent = os.path.dirname(src.rstrip('/'))
def add(z, full):
    arc = os.path.relpath(full, parent)
    st = os.lstat(full)
    zi = zipfile.ZipInfo(arc, (1980, 1, 1, 0, 0, 0))
    zi.external_attr = (st.st_mode & 0xFFFF) << 16
    zi.create_system = 3  # unix
    if stat.S_ISLNK(st.st_mode):
        z.writestr(zi, os.readlink(full))            # 符号链接: 内容=目标路径
    else:
        with open(full, 'rb') as f: z.writestr(zi, f.read())
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, dirs, files in os.walk(src):
        for name in list(dirs):
            full = os.path.join(dp, name)
            if os.path.islink(full):                 # 目录符号链接: 存为链接, 不下钻
                add(z, full); dirs.remove(name)
        for name in files:
            add(z, os.path.join(dp, name))
print('  ok', out)
PYEOF
for arch in linux-x64 win-x64 mac-x64; do
  out="$DIST/mobius-python-$arch-v${BUNDLE_VER}.zip"
  rm -f "$out"
  "$LINUX_PY" "$zip_py" "$WORK/$arch/python" "$out"
  echo "  $out  $(du -h "$out" | cut -f1)"
done
rm -f "$zip_py"
echo "== 完成. 产物: =="
ls -lh "$DIST"/mobius-python-*-v${BUNDLE_VER}.zip
