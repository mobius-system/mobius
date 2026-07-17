FROM mobius-system-base:latest


# ---------------------------------------------------------------------------
#
#
#   docker build \
#     --build-arg PROXY_HOST=your.proxy.host \
#     --build-arg PROXY_PORT=12321 \
#     --build-arg PROXY_USER=your_username \
#     --build-arg PROXY_PASS=your_password \
#     -t mobius-system:local .
#
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
# ENV fq="proxychains"

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/*

COPY . /app_image
WORKDIR /app_image
COPY ./deploy/codex /opt/codex-seed
COPY ./deploy/claude /opt/claude-seed

RUN PREFIX=/usr/local/bin bash ./scripts/install-dummy-bash-cmd-list.bash

RUN bash /app_image/mobius/scripts/setup-aimux-bridge.sh

RUN mkdir -p /app /data

# ---------------------------------------------------------------------------
#
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
