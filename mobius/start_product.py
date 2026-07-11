#!/usr/bin/env python3

#   ┌────────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
#   │ 项目           │ 值                                                                                      │
#   ├────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
#   │ 前端编译后在哪  │ $APP_DIR/mobius/public                                                    │
#   │ 后端编译后在哪  │ 无编译产物，后端直接跑源码：$APP_DIR/mobius/server.js                     │
#   │ 前端运行 cwd   │ product 模式无前端运行进程；只有 build 进程 cwd：$APP_DIR/mobius/frontend │
#   │ 后端运行 cwd   │ $APP_DIR/mobius                                                           │
#   │ 前端运行命令    │ product 模式无前端运行命令；编译命令是 npm run build                                    │
#   │ 后端运行命令    │ node server.js                                                                          │
#   └────────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘

#   ┌──────────────┬─────────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────┐
#   │ 事情         │ 代码位置                                                                            │ 现在做法                                                                       │
#   ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
#   │ 编译前端     │ mobius/start_product.py:74 build_frontend()                                         │ 编译到 staging：mobius/.build/public.next，不直接动线上 mobius/public          │
#   │ 替换编译产物 │ mobius/start_product.py:88 promote_frontend_build()                                 │ build 成功后，快速把 public.next promote 成 mobius/public；失败会回滚旧 public │
#   │ 旧部署迁移   │ mobius/start_product.py:132 prepare_for_pm2_start()                                │ 首次迁移时才 kill 旧 tmux / 清理端口；PM2 已接管后不杀端口                    │
#   │ 启动新部署   │ mobius/start_product.py:146 reload_backend()                                       │ pm2 startOrReload ecosystem.config.js --update-env                             │
#   │ 正常总顺序   │ main()                                                                              │ build staging -> promote public -> pm2 reload/start                            │
#   │ 只更新前端   │ --only-update-frontend                                                              │ build staging -> promote public；不 kill / 不清端口 / 不启动后端               │
#   └──────────────┴─────────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────┘

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# 把 repo 根目录加入 sys.path, 让下面的 `from boot_util import ...` 不论 cwd 在哪都能 import.
# start.py 用 subprocess 调本脚本, cwd 不一定是 repo 根.
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from boot_utils import (  # noqa: E402
    ConfigError,
    EnvFileLoader,
    RUNTIME_SETTINGS,
    DEFAULT_LOG_DIR,
    ensure_log_dir,
    kill_tcp_port_with_lsof,
    kill_tmux_session,
    run,
    ss_lines_for_ports,
    tmux_session_exists,
)


# 本脚本所在目录 = mobius/
HERE = Path(__file__).resolve().parent
# 老版本用 tmux 跑后端时的 session 名; 现已迁 PM2, 这个名只在迁移清理 (reset_tmux_session) 时还会用到.
SESSION = "mobius-system"
PM2_APP = "mobius-system"
KNOWN_SETTINGS = RUNTIME_SETTINGS
BUILD_DIR = HERE / ".build"
# 当前线上对外的前端静态目录 (PM2 后端 + ecosystem.config.js 静态托管这里).
PUBLIC_DIR = HERE / "public"
# 前端编译的 staging 目录; 编译完才原子替换 PUBLIC_DIR, 避免半成品被线上读到.
STAGING_PUBLIC_DIR = BUILD_DIR / "public.next"
# promote 前把当前 PUBLIC_DIR 备份到这; 替换失败时回滚用.
BACKUP_PUBLIC_DIR = BUILD_DIR / "public.previous"
# --other-versions 模式生成的临时入口; 内容是 chdir 到临时 worktree 后 require 那里的 server.js.
SERVER_TMP_VERSION = HERE / "server_tmp_version.js"
PM2_ECOSYSTEM = HERE / "ecosystem.config.js"
OTHER_VERSION_ROOT = Path(os.environ.get("MOBIUS_OTHER_VERSION_ROOT", "/tmp/mobius-system-other-versions"))


def parse_args() -> argparse.Namespace:
    # 三种运行模式由独立 flag 切换 (在 main() 互斥校验); 不传任何 flag = 走默认完整部署.
    parser = argparse.ArgumentParser(description="Build and serve Mobius product frontend/backend.")
    parser.add_argument(
        "--other-versions",
        metavar="GIT_HASH",
        help="Build frontend and serve backend from another git commit via a temporary git worktree.",
    )
    parser.add_argument(
        "--hard-reset",
        metavar="GIT_HASH",
        help="Save current HEAD to discard/<timestamp>, reset hard to the commit, then rebuild in place.",
    )
    parser.add_argument(
        "--only-update-frontend",
        action="store_true",
        help="Compile frontend and replace mobius/public without restarting backend.",
    )
    return parser.parse_args()


def set_if_blank(key: str, value: str) -> None:
    if not os.environ.get(key):
        os.environ[key] = value


def load_configuration() -> None:
    loader = EnvFileLoader(KNOWN_SETTINGS)
    # 标记当前 shell 已 export 的 env 为"已存在"; load_dotenv 不会覆盖这些, 调用方能透传临时覆盖.
    loader.mark_preexisting()
    loader.load_dotenv(REPO_ROOT / ".env", "loaded from .env")
    loader.load_dotenv(REPO_ROOT / ".env.default", "loaded from .env.default")

    debug_env_file = os.environ.get("MOBIUS_DEBUG_ENV_FILE")
    if debug_env_file:
        loader.load_runtime_json(Path(debug_env_file), "loaded from debug env")

    # 前后端必须用同一个端口: 后端 listen 这个端口, 前端构建时把 VITE_PORT 注入 vite config 做代理目标.
    # 优先用调用方 export 的值, 否则回退 45616 (生态默认口).
    product_port = os.environ.get("VITE_PORT") or os.environ.get("MOBIUS_PORT") or "45616"
    os.environ["VITE_PORT"] = product_port
    os.environ["MOBIUS_PORT"] = product_port
    set_if_blank("NODE_ENV", "production")
    # 集中日志目录: 默认 /data/logs (宿主机可见)。PM2 ecosystem / 启动包装器都读这个变量。
    set_if_blank("MOBIUS_LOG_DIR", DEFAULT_LOG_DIR)
    # PM2 不会自动建日志目录, 必须先建好, 否则 worker 首次写 out/error_file 会失败。
    ensure_log_dir()
    # 前端构建期注入的 API 反代目标; 只在没显式设时给默认, 避免覆盖 .env 的覆盖.
    set_if_blank("VITE_API_TARGET", f"http://0.0.0.0:{product_port}")


def validate_production_config() -> None:
    """启动前预检: 把 backend/config.js 在生产模式下会同步 throw 的配置在这里先拦下。

    动机: 这类 throw 发生在 require('./backend/config') 的模块加载期, PM2 cluster 模式
    往往来不及把它写进 error_file, 表现为 status=errored + 0 字节日志的"静默崩溃循环"
    (见 mobius/pm2-entrypoint.js 的说明)。在这里显式校验并给出可操作的报错, 能在 PM2
    启动之前就把根因暴露给调用方 (docker compose up 的输出里直接可见)。

    判定规则与 backend/config.js 保持一致: 空值或 change-me 开头的占位符都算未配置。
    本函数只在会真正启动后端的路径上调用 (--only-update-frontend 不启动后端, 跳过)。
    """
    problems = []
    secret = (os.environ.get("JWT_SECRET") or "").strip()
    if not secret or secret.startswith("change-me"):
        problems.append(
            "JWT_SECRET 未设置或仍是占位符 (change-me-...)。生产模式后端会拒绝启动。\n"
            "      修复: 在 .env 中设置 JWT_SECRET=<随机长字符串>\n"
            "      生成: openssl rand -hex 32"
        )
    if problems:
        raise ConfigError("生产环境配置预检失败:\n  " + "\n  ".join(problems))


def build_frontend(
    mobius_dir: Path = HERE,
    staging_public_dir: Path = STAGING_PUBLIC_DIR,
    step_label: str = "[1/4]",
) -> Path:
    print(f"=== {step_label} compile frontend into staging ===", flush=True)
    # staging 目录可能是上次失败遗留的半成品, 先清掉再编, 避免脏文件混进新产物.
    if staging_public_dir.exists():
        shutil.rmtree(staging_public_dir)
    staging_public_dir.parent.mkdir(parents=True, exist_ok=True)
    # vite 的 outDir 用相对路径传 (相对 frontend cwd), 指向 mobius/.build/public.next.
    out_dir = os.path.relpath(staging_public_dir, mobius_dir / "frontend")
    build_env = dict(os.environ)
    build_env["MOBIUS_FRONTEND_OUT_DIR"] = out_dir

    # --emptyOutDir 让 vite 清掉 staging (我们已经 rmtree 过, 双保险); 关键是产物落 staging 而不是线上.
    run(
        ["npm", "run", "build", "--", "--emptyOutDir"],
        cwd=mobius_dir / "frontend",
        env=build_env,
    )
    return staging_public_dir


def promote_frontend_build(staging_dir: Path, step_label: str = "[2/4]") -> None:
    print()
    print(f"=== {step_label} promote compiled frontend ===", flush=True)
    # 用 index.html 当产物完整性哨兵: 没编出来就别动线上目录.
    if not (staging_dir / "index.html").is_file():
        raise ConfigError(f"compiled frontend missing {staging_dir / 'index.html'}")

    # 清理上一轮残留的 backup 目录, 给本轮腾位.
    if BACKUP_PUBLIC_DIR.exists():
        shutil.rmtree(BACKUP_PUBLIC_DIR)

    moved_current_public = False
    try:
        # rename 在同盘是原子的; 把当前 public 挪到 backup, 再把 staging 挪上来.
        # 两次 rename 之间线上 public 会"消失"一个极短窗口, 但比 rmtree+copytree 快得多.
        if PUBLIC_DIR.exists():
            PUBLIC_DIR.rename(BACKUP_PUBLIC_DIR)
            moved_current_public = True
        staging_dir.rename(PUBLIC_DIR)
    except Exception:
        # 只有"已经把 public 挪走, 但 staging 没成功上位"的情况才回滚: 把 backup 挪回去.
        # staging 上位成功但后续抛错的情况不能动, 否则会用旧 public 覆盖新 public.
        if moved_current_public and not PUBLIC_DIR.exists() and BACKUP_PUBLIC_DIR.exists():
            BACKUP_PUBLIC_DIR.rename(PUBLIC_DIR)
        raise

    # 替换成功, backup 没用了, 删掉.
    if BACKUP_PUBLIC_DIR.exists():
        shutil.rmtree(BACKUP_PUBLIC_DIR)


def reset_tmux_session() -> None:
    if tmux_session_exists(SESSION):
        print(f"kill existing {SESSION}")
        kill_tmux_session(SESSION)


def free_application_ports() -> None:
    # 同一个端口可能同时出现在 MOBIUS_PORT 和 VITE_PORT (load_configuration 把它们同步成同一个值);
    # dict.fromkeys 去重避免对同一端口 kill 两次.
    ports = list(dict.fromkeys([os.environ["MOBIUS_PORT"], os.environ["VITE_PORT"]]))

    for port in ports:
        if kill_tcp_port_with_lsof(port):
            print(f"port {port} occupied, killing")
            # 给内核 / 监听进程一个释放窗口, 紧接着 startOrReload 才不会撞 EADDRINUSE.
            time.sleep(0.2)


def pm2_command() -> list[str]:
    # --no-install 防止 npx 在没装 pm2 时跑去联网安装, 让 PM2 缺失时显式报错而不是悄悄装个新版本.
    return ["npx", "--no-install", "pm2"]


def pm2_app_exists() -> bool:
    try:
        # pm2 describe 对不存在的 app 返回非 0; check=False 让我们拿到 returncode 自己判断.
        result = run(pm2_command() + ["describe", PM2_APP], cwd=HERE, check=False, quiet=True)
    except FileNotFoundError as exc:
        # npm/npx 都没装 → 不是配置问题是环境问题, 抛 ConfigError 让上层走 stderr 退出码 2.
        raise ConfigError("npm/npx 未找到，无法启动 PM2") from exc
    return result.returncode == 0


def prepare_for_pm2_start() -> None:
    # 关键幂等门槛: 只有首次从 tmux 迁 PM2 (PM2 还没接管过) 时才 kill tmux / 清端口.
    # PM2 已管理后端时绝不能清端口 — 会误杀自己即将 reload 的进程.
    if pm2_app_exists():
        return
    reset_tmux_session()
    free_application_ports()


def ensure_aimux_bridge_runtime_env() -> None:
    """Populate AIMUX_BRIDGE_* defaults so PM2 ecosystem + Node backend pick them up."""
    core_data = os.environ.get("CORE_DATA_PATH") or str(REPO_ROOT / "protected_data")
    os.environ.setdefault("AIMUX_BRIDGE_HOST", "127.0.0.1")
    os.environ.setdefault("AIMUX_BRIDGE_PORT", "33315")
    # AIMUX_BRIDGE_RUNTIME 不显式设: 让 aimux CLI/broker 走自身默认 fallback (~/.aimux/bridge/runtime.json).
    # 这样 agent 调 aimux CLI 时无需 export env, 跟 aimux 0.1.9 上游行为一致.
    # 若调用方显式设了 AIMUX_BRIDGE_RUNTIME (如老部署 / 容器化场景), ecosystem.config.js envKeys 仍会透传.


def ensure_aimux_bridge_venv() -> None:
    """Install mobius/.venv-aimux with aimux==0.1.9 if missing (idempotent)."""
    # 用 venv 内的 aimux 二进制存在性作为"是否已装"的哨兵, 避免重复跑 setup 脚本.
    venv_aimux = HERE / ".venv-aimux" / "bin" / "aimux"
    if venv_aimux.exists():
        return
    print("=== setting up aimux bridge venv (mobius/.venv-aimux) ===", flush=True)
    run(["bash", str(HERE / "scripts" / "setup-aimux-bridge.sh")], cwd=HERE)


def reload_backend(entrypoint: Path = HERE / "pm2-entrypoint.js") -> None:
    print()
    print(f"=== [3/4] reload product backend with PM2 :{os.environ['MOBIUS_PORT']} ===", flush=True)

    if not PM2_ECOSYSTEM.is_file():
        raise ConfigError(f"missing PM2 ecosystem file: {PM2_ECOSYSTEM}")

    env = dict(os.environ)
    # ecosystem.config.js 读这个变量决定入口: 正常是 server.js, --other-versions 时是临时生成的 server_tmp_version.js.
    env["MOBIUS_PM2_ENTRYPOINT"] = str(entrypoint)
    # startOrReload 幂等: 没 app 就 start, 有就 reload; --update-env 让本次 env 改动透传给运行中的进程.
    run(pm2_command() + ["startOrReload", PM2_ECOSYSTEM, "--update-env"], cwd=HERE, env=env)


def resolve_commit_hash(raw_hash: str, label: str) -> str:
    value = str(raw_hash or "").strip()
    # 先正则白名单校验, 再交给 git rev-parse; 避免把任意字符串当 ref 让 git 解释出意外结果.
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", value):
        raise ConfigError(f"{label} 必须是 7-40 位 git commit hash")
    result = run(
        ["git", "rev-parse", "--verify", f"{value}^{{commit}}"],
        cwd=REPO_ROOT,
        capture=True,
    )
    return result.stdout.strip()


def resolve_other_version_hash(raw_hash: str) -> str:
    return resolve_commit_hash(raw_hash, "other version")


def clear_tmp_version_entrypoint() -> None:
    # .exists() 对断链 symlink 返回 False, 必须额外看 .is_symlink() 才能清理掉断链残留.
    if SERVER_TMP_VERSION.exists() or SERVER_TMP_VERSION.is_symlink():
        SERVER_TMP_VERSION.unlink()


def copy_if_exists(src: Path, dst: Path) -> None:
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def symlink_dependency_dir(src: Path, dst: Path) -> None:
    if dst.exists() or dst.is_symlink():
        return
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    # symlink 而非 copy: 让临时 worktree 复用主仓的 node_modules, 避免每次切版本都重新 npm install.
    os.symlink(src, dst, target_is_directory=True)


def prepare_other_version_worktree(commit_hash: str) -> Path:
    OTHER_VERSION_ROOT.mkdir(parents=True, exist_ok=True)
    # tempfile.mkdtemp 会真创建目录; git worktree add 要求目标不能已存在, 先 rmdir 把空目录还回去.
    worktree = Path(tempfile.mkdtemp(prefix=f"mobius-{commit_hash[:12]}-", dir=OTHER_VERSION_ROOT))
    worktree.rmdir()
    # --detach 让 worktree 处于 detached HEAD, 不创建/移动分支, 不影响主仓 working tree.
    run(["git", "worktree", "add", "--detach", worktree, commit_hash], cwd=REPO_ROOT)

    # git worktree 只带被 Git 跟踪的源码; 本地部署需要的 env 和依赖目录显式带过去.
    copy_if_exists(REPO_ROOT / ".env", worktree / ".env")
    copy_if_exists(REPO_ROOT / ".env.default", worktree / ".env.default")
    symlink_dependency_dir(HERE / "node_modules", worktree / "mobius" / "node_modules")
    symlink_dependency_dir(HERE / "frontend" / "node_modules", worktree / "mobius" / "frontend" / "node_modules")
    return worktree


def write_tmp_version_entrypoint(worktree: Path, commit_hash: str) -> None:
    mobius_dir = worktree / "mobius"
    server_js = mobius_dir / "server.js"
    if not server_js.is_file():
        raise ConfigError(f"other version missing {server_js}")
    # 生成的入口文件写回主仓 mobius/ 下, 这样 PM2 ecosystem 的 cwd=mobius/ 不用改;
    # 通过 process.chdir 切到临时 worktree, 再 require 那里的 server.js — 让旧版本源码在 PM2 进程里跑起来.
    # json.dumps 保证 hash/path 被安全转义成 JS 字符串字面量, 避免 worktree 路径里有特殊字符破坏生成代码.
    SERVER_TMP_VERSION.write_text(
        "\n".join([
            "// Generated by mobius/start_product.py --other-versions.",
            "// Do not edit or commit this file.",
            f"process.env.MOBIUS_OTHER_VERSION_HASH = {json.dumps(commit_hash)};",
            f"process.env.MOBIUS_OTHER_VERSION_WORKTREE = {json.dumps(str(worktree))};",
            f"process.chdir({json.dumps(str(mobius_dir))});",
            f"require({json.dumps(str(server_js))});",
            "",
        ]),
        encoding="utf-8",
    )


def deploy_other_version(raw_hash: str) -> None:
    commit_hash = resolve_other_version_hash(raw_hash)
    print(f"=== [other-version] build Mobius from {commit_hash} ===")
    worktree = prepare_other_version_worktree(commit_hash)
    mobius_dir = worktree / "mobius"
    # staging 落在 worktree 内, 编译完再 promote 回主仓 PUBLIC_DIR.
    staging_dir = mobius_dir / ".build" / "public.next"
    staging_dir = build_frontend(mobius_dir, staging_dir)

    # 注意: 这里的 temp_public 是 worktree 内的 public, 仅用于 worktree 自洽; 真正上线靠 promote_frontend_build.
    temp_public = mobius_dir / "public"
    if temp_public.exists():
        shutil.rmtree(temp_public)
    shutil.copytree(staging_dir, temp_public)

    promote_frontend_build(staging_dir)
    write_tmp_version_entrypoint(worktree, commit_hash)
    ensure_aimux_bridge_runtime_env()
    ensure_aimux_bridge_venv()
    prepare_for_pm2_start()
    # 用临时生成的 server_tmp_version.js 作为入口, 而不是主仓的 server.js.
    reload_backend(SERVER_TMP_VERSION)
    # 给后端一点 boot 时间, 再 print_status 探端口, 避免端口还没 listen 就读到空.
    time.sleep(2)
    print_status()


def build_and_start_current_tree() -> None:
    # 正常路径入口: 清掉上一次 --other-versions 残留的临时入口, 回到主仓 server.js.
    clear_tmp_version_entrypoint()
    staging_dir = build_frontend()
    promote_frontend_build(staging_dir)
    ensure_aimux_bridge_runtime_env()
    ensure_aimux_bridge_venv()
    prepare_for_pm2_start()
    reload_backend()
    time.sleep(2)
    print_status()


def update_frontend_only() -> None:
    # 仅前端热更新: 跳过所有后端/PM2/端口操作, 前端 build -> promote, 后端原地继续服务新前端.
    staging_dir = build_frontend(step_label="[1/2]")
    promote_frontend_build(staging_dir, step_label="[2/2]")
    print_frontend_update_status()


def discard_branch_exists(branch_name: str) -> bool:
    result = run(
        ["git", "rev-parse", "--verify", f"refs/heads/{branch_name}"],
        cwd=REPO_ROOT,
        check=False,
        quiet=True,
    )
    return result.returncode == 0


def create_discard_branch() -> str:
    # --hard-reset 是破坏性操作: 先把当前 HEAD 存成 discard/<ts> 分支, 万一回滚错了还能从这里捞回来.
    current_head = run(["git", "rev-parse", "--verify", "HEAD"], cwd=REPO_ROOT, capture=True).stdout.strip()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    base_name = f"discard/{timestamp}"
    branch_name = base_name
    suffix = 1
    # 同一秒多次调用会撞名, 加 -2/-3 后缀去重; 用 UTC 避免本机时区干扰排序.
    while discard_branch_exists(branch_name):
        suffix += 1
        branch_name = f"{base_name}-{suffix}"
    run(["git", "branch", branch_name, current_head], cwd=REPO_ROOT)
    print(f"saved current HEAD {current_head} to branch {branch_name}")
    return branch_name


def hard_reset_current_tree(raw_hash: str) -> None:
    commit_hash = resolve_commit_hash(raw_hash, "hard reset target")
    print(f"=== [hard-reset] save current HEAD then reset Mobius to {commit_hash} ===")
    clear_tmp_version_entrypoint()
    discard_branch = create_discard_branch()
    # 注意: 这是 repo 级 reset --hard, 会清掉主仓 working tree 的未提交改动;
    # 调用前需自行确认 working tree 已提交或被 auto-commit watcher 接管.
    run(["git", "reset", "--hard", commit_hash], cwd=REPO_ROOT)
    print(f"reset complete; previous HEAD is preserved at {discard_branch}")
    build_and_start_current_tree()


def print_status() -> None:
    port = os.environ["MOBIUS_PORT"]
    protected_data = os.environ.get("CORE_DATA_PATH") or str(REPO_ROOT / "protected_data")
    bridge_port = os.environ.get("AIMUX_BRIDGE_PORT", "33315")
    bridge_runtime = os.environ.get("AIMUX_BRIDGE_RUNTIME", "(default ~/.aimux/bridge/runtime.json)")

    print()
    print("=== [4/4] product stack status ===")
    # ss 探活: 列出当前监听这些端口的进程, 让人能肉眼确认 PM2 真起没起、有没有别的进程抢端口.
    for line in ss_lines_for_ports([port, bridge_port], include_process=True):
        print(line)

    print()
    print(f"pm2 app:        {PM2_APP} + mobius-system-bridge")
    print(f"frontend:       http://0.0.0.0:{port}")
    print(f"backend health: http://0.0.0.0:{port}/api/v2/health")
    print(f"aimux bridge:   http://127.0.0.1:{bridge_port} (proxy: /aimux_bridge/*)")
    print(f"bridge runtime: {bridge_runtime}")
    print(f"database:       {os.environ.get('DB_PATH', '(server default)')}")
    print(f"protected_data: {protected_data}")
    print()
    print(f"attach logs:    cd {HERE} && npx --no-install pm2 logs {PM2_APP} mobius-system-bridge")
    print(f"stop:           cd {HERE} && npx --no-install pm2 stop {PM2_APP} mobius-system-bridge")


def print_frontend_update_status() -> None:
    port = os.environ["MOBIUS_PORT"]

    print()
    print("=== frontend update complete ===")
    for line in ss_lines_for_ports([port], include_process=True):
        print(line)

    print()
    print("frontend files: mobius/public")
    print(f"frontend:       http://0.0.0.0:{port}")
    # --only-update-frontend 不动后端: 这里只如实告诉调用方"后端还在不在 / 谁在管它", 不主动启动.
    if pm2_app_exists():
        print(f"backend:        existing PM2 app {PM2_APP} left running")
    elif tmux_session_exists(SESSION):
        print(f"backend:        existing tmux session {SESSION} left running")
    else:
        print(f"backend:        no existing backend process detected; not started")


def main() -> int:
    args = parse_args()
    try:
        load_configuration()
        # 模式互斥: 这几个开关分别走完全不同的代码路径, 一起传属于误用, 显式报错而不是默认走某一条.
        if args.other_versions and args.hard_reset:
            raise ConfigError("--other-versions 和 --hard-reset 不能同时使用")
        if args.only_update_frontend and (args.other_versions or args.hard_reset):
            raise ConfigError("--only-update-frontend 不能和 --other-versions / --hard-reset 同时使用")
        if args.only_update_frontend:
            update_frontend_only()
            return 0
        # 下面三条路径都会真正启动后端: 先做生产配置预检, 把 config.js 的启动期 throw
        # 在 PM2 之前拦下, 避免 cluster 模式吞掉错误 (status=errored + 空日志)。
        validate_production_config()
        if args.other_versions:
            deploy_other_version(args.other_versions)
            return 0
        if args.hard_reset:
            hard_reset_current_tree(args.hard_reset)
            return 0
        build_and_start_current_tree()
        return 0
    except ConfigError as exc:
        # 配置/参数类错误: 用退出码 2 区别于子进程失败.
        print(f"start_product.py: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        # 子进程失败: 透传子进程退出码 (兜底 1), 让上层 (start.py / 部署脚本) 能据此判成败.
        print(f"start_product.py: command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
