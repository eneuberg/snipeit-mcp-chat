FROM node:22-slim

ARG WEBUI_VERSION=0.1.56
# TARGETARCH is auto-provided by BuildKit/buildx (amd64 on x86_64, arm64
# on Raspberry Pi 4/5 64-bit). Fall back to the host's dpkg arch for
# plain `docker build` without BuildKit. Upstream releases two binaries:
# claude-code-webui-linux-x64 and claude-code-webui-linux-arm64.
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq tini \
    && rm -rf /var/lib/apt/lists/* \
    && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) webui_arch=linux-x64 ;; \
         arm64) webui_arch=linux-arm64 ;; \
         *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/claude-code-webui \
         "https://github.com/sugyan/claude-code-webui/releases/download/${WEBUI_VERSION}/claude-code-webui-${webui_arch}" \
    && chmod +x /usr/local/bin/claude-code-webui \
    && npm install -g @anthropic-ai/claude-code

# First-boot seed: copies OAuth + MCP config from read-only /seed mounts
# into the container's named-volume home on first start only.
COPY --chmod=755 entrypoint.sh /usr/local/bin/webui-entrypoint

# HTML-injection proxy that adds an "Add project" button to the upstream
# UI and exposes /_ext/add-project for registering new project paths.
# Runs in front of claude-code-webui (which it spawns internally on
# 127.0.0.1:8079).
COPY --chmod=644 proxy.js /usr/local/bin/webui-proxy.js

# The `claude` binary installed via npm uses `#!/usr/bin/env node`. The
# Deno-bundled SDK inside webui spawns claude with a restricted PATH that
# doesn't include /usr/local/bin, so `env node` can't find the interpreter
# (ENOENT). Symlink node into /usr/bin (which is always in PATH) so the
# shebang resolves regardless of the child env. Keep the original claude
# symlink intact so webui's script-path detection still works.
RUN ln -s /usr/local/bin/node /usr/bin/node

# Create /workspace owned by node. The named volume mounted here at
# runtime inherits ownership from this dir on first boot, so the node
# user can write to its own scratch filesystem.
RUN install -d -o node -g node -m 755 /workspace

# node:22-slim ships a `node` user at UID 1000 already — reuse it so
# bind-mounted ~/.claude stays writable with host perms.
USER node
WORKDIR /home/node

ENV PORT=3583 HOST=0.0.0.0

EXPOSE 3583
ENTRYPOINT ["tini", "--", "webui-entrypoint"]
# The proxy binds :$PORT (default 3583) and spawns claude-code-webui on
# 127.0.0.1:8079 internally, passing --claude-path so the SDK spawn
# doesn't ENOENT.
CMD ["node", "/usr/local/bin/webui-proxy.js"]
