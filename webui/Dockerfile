ARG FORK_REPO=https://github.com/eneuberg/claude-code-webui.git
ARG FORK_REF=main

# ---- Builder: build frontend + backend bundle from our fork ----
FROM node:22-slim AS builder
ARG FORK_REPO
ARG FORK_REF
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch "${FORK_REF}" "${FORK_REPO}" .
RUN cd frontend && npm ci && npm run build
RUN cd backend && npm ci && npm run build

# ---- Runtime ----
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates jq tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Install webui bundle + runtime deps (externalised by esbuild).
WORKDIR /opt/webui
COPY --from=builder /build/backend/package.json ./package.json
COPY --from=builder /build/backend/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY --from=builder /build/backend/dist ./dist

# First-boot seed + knowledge base template (unchanged).
COPY --chmod=755 entrypoint.sh /usr/local/bin/webui-entrypoint
COPY --chown=node:node workspace-template /seed/workspace

# `claude` uses `#!/usr/bin/env node`; SDK spawns it with restricted PATH.
RUN ln -s /usr/local/bin/node /usr/bin/node \
    && install -d -o node -g node -m 755 /workspace

USER node
WORKDIR /home/node

ENV PORT=3583 HOST=0.0.0.0 \
    WEBUI_PROJECT_ROOT=/workspace \
    WEBUI_UPLOAD_DIR=/workspace/_uploads

EXPOSE 3583
ENTRYPOINT ["tini", "--", "webui-entrypoint"]
CMD ["node", "/opt/webui/dist/cli/node.js", \
     "--host", "0.0.0.0", "--port", "3583", \
     "--claude-path", "/usr/local/bin/claude"]
