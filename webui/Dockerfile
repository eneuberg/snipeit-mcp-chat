FROM node:22-slim

ARG WEBUI_VERSION=0.1.56
# linux-x64 or linux-arm64 depending on the host (Pi 4/5 uses arm64).
ARG WEBUI_ARCH=linux-x64

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/claude-code-webui \
         https://github.com/sugyan/claude-code-webui/releases/download/${WEBUI_VERSION}/claude-code-webui-${WEBUI_ARCH} \
    && chmod +x /usr/local/bin/claude-code-webui \
    && npm install -g @anthropic-ai/claude-code

# Pre-create /home/node/.claude.json as a file so the bind-mount attaches
# to a file target (otherwise Docker auto-creates a directory and webui
# crashes with EISDIR reading it).
RUN install -o node -g node -m 600 /dev/null /home/node/.claude.json

# The `claude` binary installed via npm uses `#!/usr/bin/env node`. The
# Deno-bundled SDK inside webui spawns claude with a restricted PATH that
# doesn't include /usr/local/bin, so `env node` can't find the interpreter
# (ENOENT). Symlink node into /usr/bin (which is always in PATH) so the
# shebang resolves regardless of the child env. Keep the original claude
# symlink intact so webui's script-path detection still works.
RUN ln -s /usr/local/bin/node /usr/bin/node

# node:22-slim ships a `node` user at UID 1000 already — reuse it so
# bind-mounted ~/.claude stays writable with host perms.
USER node
WORKDIR /home/node

ENV PORT=8080 HOST=0.0.0.0

EXPOSE 8080
ENTRYPOINT ["tini", "--"]
# --claude-path is required: webui's own PATH-based detection finds the
# CLI, but the embedded @anthropic-ai/claude-code SDK spawns it separately
# and fails with ENOENT unless the path is explicit.
CMD ["claude-code-webui", "--host", "0.0.0.0", "--port", "8080", \
     "--claude-path", "/usr/local/bin/claude"]
