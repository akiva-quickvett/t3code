# Hosted T3 Code for Railway: this fork built from source, served by `t3 serve`
# with the t3 user's home on a persistent volume. Build context is the repo
# root. Setup, pairing and operations: deploy/railway/README.md.

# Keep in step with engines.node in package.json.
ARG NODE_VERSION=26.12.1

FROM node:${NODE_VERSION}-bookworm AS build

# The Vite+ CLI is the repo's task runner and pins pnpm from package.json.
# VP_NODE_MANAGER=no keeps the image's Node instead of a vp-managed one.
ENV CI=true \
    VP_NODE_MANAGER=no \
    VP_HOME=/opt/vite-plus \
    PATH=/opt/vite-plus/bin:$PATH
RUN curl -fsSL https://vite.plus -o /tmp/vite-plus.sh \
    && bash /tmp/vite-plus.sh \
    && rm /tmp/vite-plus.sh \
    && test -x /opt/vite-plus/bin/vp

WORKDIR /opt/t3code
# The web build reads license files from across the tree, so copy all of it.
# .repos is vendored reference source the build never reads.
COPY . .
# .env.example holds the public T3 Connect identifiers release builds embed;
# without them the build ships with T3 Connect disabled.
RUN rm -rf .repos .git && cp .env.example .env
RUN vp install --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts...
RUN vp run --filter t3 build

FROM node:${NODE_VERSION}-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git gnupg jq less openssh-client procps ripgrep tini \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Bookworm's python3 is 3.11, so ship a uv-managed 3.13 (fixed by the uv pin)
# as the system python3, with pip and venv. Pythons and the cache t3 adds
# later live in its home, on the volume.
COPY --from=ghcr.io/astral-sh/uv:0.12.24 /uv /uvx /usr/local/bin/
RUN UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_BIN_DIR=/usr/local/bin \
       uv python install 3.13 --default --no-cache \
    && printf '%s\n' '#!/bin/sh' 'exec python3 -m pip "$@"' > /usr/local/bin/pip \
    && chmod 755 /usr/local/bin/pip \
    && ln -s pip /usr/local/bin/pip3 \
    && python3 -m venv --help >/dev/null \
    && pip --version

# The image's uid 1000 user becomes t3. Its home is the Railway volume; the
# skeleton is copied in by the entrypoint on first boot.
RUN usermod -l t3 -d /home/t3 node \
    && groupmod -n t3 node \
    && mkdir -p /opt/t3-home-skel \
    && cp /etc/skel/.bashrc /etc/skel/.profile /opt/t3-home-skel/

COPY --from=build /opt/t3code /opt/t3code

# pnpm at the version package.json pins, for working on repos in ~/work.
RUN npm install -g "$(node -p 'require("/opt/t3code/package.json").packageManager')" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force
COPY deploy/railway/entrypoint.sh /usr/local/bin/t3-entrypoint

# `railway ssh` lands as root. Running t3 as root would leave root-owned
# files in ~/.t3, so the CLI always drops to the t3 user.
RUN printf '%s\n' '#!/bin/sh' \
      'if [ "$(id -u)" = 0 ]; then' \
      '  exec setpriv --reuid=t3 --regid=t3 --init-groups env -u RAILWAY_API_TOKEN HOME=/home/t3 USER=t3 LOGNAME=t3 SHELL=/bin/bash "$0" "$@"' \
      'fi' \
      'exec node /opt/t3code/apps/server/dist/bin.mjs "$@"' \
      > /usr/local/bin/t3 \
    && chmod 755 /usr/local/bin/t3 /usr/local/bin/t3-entrypoint \
    && printf '%s\n' 'export DISABLE_AUTOUPDATER=1' \
         'export UV_CACHE_DIR=/home/t3/.cache/uv UV_PYTHON_INSTALL_DIR=/home/t3/.local/share/uv/python' \
         > /etc/profile.d/t3.sh

# Claude Code lives in the root-owned global prefix; update it by redeploying.
ENV PATH=/home/t3/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    UV_CACHE_DIR=/home/t3/.cache/uv \
    UV_PYTHON_INSTALL_DIR=/home/t3/.local/share/uv/python

EXPOSE 8080
# tini reaps the orphans agent and terminal shells leave behind.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3-entrypoint"]
