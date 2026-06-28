FROM mobius-system-base:latest


# ---------------------------------------------------------------------------
# 代理网络配置（可选）
#
# 如需在 Docker build / 容器内使用 HTTP 代理穿越防火墙，通过 build ARG 传入，
# 不要把代理账号密码直接写在 Dockerfile 里。
#
# 构建时传参示例：
#   docker build \
#     --build-arg PROXY_HOST=your.proxy.host \
#     --build-arg PROXY_PORT=12321 \
#     --build-arg PROXY_USER=your_username \
#     --build-arg PROXY_PASS=your_password \
#     -t mobius-system:local .
#
# 不需要代理时：注释掉下面的 ARG/RUN 段，取消注释 `ENV fq=""`。
# ---------------------------------------------------------------------------
ARG PROXY_HOST=""
ARG PROXY_PORT=""
ARG PROXY_USER=""
ARG PROXY_PASS=""
RUN if [ -n "$PROXY_HOST" ] && [ -n "$PROXY_PORT" ]; then \
      sed -i '$ d' /etc/proxychains4.conf; \
      sed -i '$ d' /etc/proxychains4.conf; \
      echo "http  ${PROXY_HOST}  ${PROXY_PORT} ${PROXY_USER} ${PROXY_PASS}" | tee -a /etc/proxychains4.conf; \
    fi
ENV fq=""
# 若 PROXY_HOST 不为空则启用 proxychains；build 阶段 ARG 不能直接赋给 ENV，
# 用 shell 判断写入环境文件，entrypoint 里再 source。
# 简化做法：如果你需要代理，手动将下一行 ENV fq="" 改为 ENV fq="proxychains"
# ENV fq="proxychains"

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/*

COPY . /app_image
WORKDIR /app_image
# codex / claude 凭证种子: 放到不被 bind mount 遮盖的位置, entrypoint 首次启动时,
# 若 host 挂载的 /root/.codex 或 /root/.claude 为空则从这里播种 (见 docker-entrypoint.sh)。
COPY ./deploy/codex /opt/codex-seed
COPY ./deploy/claude /opt/claude-seed

# 安装占位图片展示命令到全局 PATH, 供 agent 在容器内直接调用 display_images。
RUN PREFIX=/usr/local/bin bash ./scripts/install-dummy-bash-cmd-list.bash

# uv (Rust 单文件 binary, 通过 pip 装最稳) + aimux bridge venv.
# venv 不放 /app_image 而是放 mobius/.venv-aimux, 让 host 与 docker 共用同一份 setup 脚本.
RUN bash /app_image/mobius/scripts/setup-aimux-bridge.sh

RUN mkdir -p /app /data

# ---------------------------------------------------------------------------
# Git 全局用户配置
# 通过 build ARG 传入，避免个人信息硬编码在镜像层中。
#
# 构建时传参示例：
#   docker build \
#     --build-arg GIT_USER_EMAIL=your@email.com \
#     --build-arg GIT_USER_NAME="Your Name" \
#     -t mobius-system:local .
# ---------------------------------------------------------------------------
ARG GIT_USER_EMAIL="dev@example.com"
ARG GIT_USER_NAME="Mobius Dev"
RUN git config --global user.email "${GIT_USER_EMAIL}" \
 && git config --global user.name  "${GIT_USER_NAME}"

CMD ["bash", "/app_image/docker-entrypoint.sh"]
