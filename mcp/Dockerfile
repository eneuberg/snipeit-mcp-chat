# Local build for jameshgordy/snipeit-mcp with fixes we can't land upstream:
#   1. Pin fastmcp to 2.12.4 (from upstream uv.lock). Upstream's Dockerfile
#      installs with `uv pip install .` which ignores the lockfile and pulls
#      the latest fastmcp — newer versions no longer expose `_tool_manager`,
#      which server.py references unconditionally (line 5410/5418).
#   2. Launch over HTTP via `mcp.run(transport="http", ...)` — the upstream
#      runtime image doesn't have the `fastmcp` CLI on PATH.

FROM python:3.12-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 https://github.com/jameshgordy/snipeit-mcp.git .

RUN pip install --no-cache-dir uv \
    && uv pip install --system --no-cache . \
    && pip install --no-cache-dir "fastmcp==2.12.4" "Pillow>=10.4"

FROM python:3.12-slim

RUN useradd --create-home --shell /bin/bash appuser

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/ /usr/local/bin/

WORKDIR /app
# Patch snipeit-api client: allow plain http:// URLs (not just https:// / localhost)
RUN python3 -c "import pathlib; p=pathlib.Path('/usr/local/lib/python3.12/site-packages/snipeit/client.py'); t=p.read_text(); t=t.replace('\"http://localhost\"','\"http://\"'); p.write_text(t)"
COPY --from=builder --chown=appuser:appuser /build/server.py ./
COPY --from=builder --chown=appuser:appuser /build/prompts/ prompts/

# Local extension: `asset_thumbnail` tool — the upstream MCP only covers the
# Files-tab upload via `asset_files`; this adds the main-image (thumbnail)
# endpoint. Registered by importing the module just before the allowed-tools
# whitelist filter runs, so the tool name is subject to SNIPEIT_ALLOWED_TOOLS.
COPY --chown=appuser:appuser asset_thumbnail_tool.py ./
RUN sed -i '/^SNIPEIT_ALLOWED_TOOLS = os.getenv/i import asset_thumbnail_tool  # noqa: F401 -- registers asset_thumbnail via @mcp.tool side effect\n' /app/server.py

USER appuser

EXPOSE 8000

CMD ["python", "-c", "from server import mcp; mcp.run(transport='http', host='0.0.0.0', port=8000)"]
