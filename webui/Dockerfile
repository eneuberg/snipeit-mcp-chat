FROM node:22-slim

ARG WEBUI_VERSION=0.1.56
# linux-x64 or linux-arm64 depending on the host (Pi 4/5 uses arm64).
ARG WEBUI_ARCH=linux-x64

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/claude-code-webui \
         https://github.com/sugyan/claude-code-webui/releases/download/${WEBUI_VERSION}/claude-code-webui-${WEBUI_ARCH} \
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

ENV PORT=8080 HOST=0.0.0.0

EXPOSE 8080
ENTRYPOINT ["tini", "--", "webui-entrypoint"]
# The proxy binds :8080 and spawns claude-code-webui on 127.0.0.1:8079
# internally, passing --claude-path so the SDK spawn doesn't ENOENT.
CMD ["node", "/usr/local/bin/webui-proxy.js"]
