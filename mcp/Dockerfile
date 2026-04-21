# Builds the Snipe-IT MCP server from our fork (eneuberg/snipeit-mcp).
#
# The fork carries three modifications on top of upstream:
#   1. fastmcp pinned to 2.12.4 (newer versions drop _tool_manager,
#      which server.py references for the SNIPEIT_ALLOWED_TOOLS
#      whitelist).
#   2. asset_thumbnail tool — sets the main header image on an asset,
#      which upstream asset_files (Files-tab only) doesn't cover.
#   3. Pillow-based compression on both asset_thumbnail and
#      asset_files to keep uploads under Snipe-IT's 25 MB cap without
#      libvips overhead on Pi-class hardware.
#
# One patch still lives here, not in the fork: the snipeit-api client
# library rejects plain http:// URLs for non-localhost hosts. That's
# an external dependency (lfctech/snipeit-python-api), not ours to
# edit at the fork level.

FROM python:3.12-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 https://github.com/eneuberg/snipeit-mcp.git .

RUN pip install --no-cache-dir uv \
    && uv pip install --system --no-cache .

FROM python:3.12-slim

RUN useradd --create-home --shell /bin/bash appuser

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/ /usr/local/bin/

WORKDIR /app
# Patch snipeit-api client: allow plain http:// URLs (not just https:// / localhost).
# External dependency — can't land this in our fork of snipeit-mcp itself.
RUN python3 -c "import pathlib; p=pathlib.Path('/usr/local/lib/python3.12/site-packages/snipeit/client.py'); t=p.read_text(); t=t.replace('\"http://localhost\"','\"http://\"'); p.write_text(t)"
COPY --from=builder --chown=appuser:appuser /build/server.py ./
COPY --from=builder --chown=appuser:appuser /build/compression.py ./
COPY --from=builder --chown=appuser:appuser /build/asset_thumbnail_tool.py ./
COPY --from=builder --chown=appuser:appuser /build/asset_files_compression.py ./
COPY --from=builder --chown=appuser:appuser /build/prompts/ prompts/

USER appuser

EXPOSE 8000

CMD ["python", "-c", "from server import mcp; mcp.run(transport='http', host='0.0.0.0', port=8000)"]
