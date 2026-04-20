#!/bin/sh
set -e

CLAUDE_DIR=/home/node/.claude
CLAUDE_JSON=/home/node/.claude.json
SEED_CLAUDE_DIR=/seed/claude
SEED_CLAUDE_JSON=/seed/claude.json

MCP_URL_EFFECTIVE="${MCP_URL:-http://snipeit-mcp:8000/mcp/}"

# First-boot seed. Copies OAuth creds + MCP config from the host
# read-only mounts into the container's named-volume home. Never
# overwrites existing credentials or session history on subsequent
# boots — refreshed tokens persist.
#
# Fail-closed: if the named volume is empty AND the host seed is
# missing, exit 1 instead of booting a broken container (webui's
# /api/projects 500s loudly in that state, which is hard to diagnose).
if [ -f "$CLAUDE_JSON" ]; then
    echo "[entrypoint] $CLAUDE_JSON already present — keeping forked state."
else
    if [ ! -f "$SEED_CLAUDE_JSON" ]; then
        echo "[entrypoint] FATAL: seed file $SEED_CLAUDE_JSON is missing." >&2
        echo "[entrypoint]   -> set CLAUDE_CONFIG_FILE to point at your host's .claude.json" >&2
        echo "[entrypoint]      (run 'claude login' first if you haven't)." >&2
        exit 1
    fi
    if [ ! -f "$SEED_CLAUDE_DIR/.credentials.json" ]; then
        echo "[entrypoint] FATAL: seed file $SEED_CLAUDE_DIR/.credentials.json is missing." >&2
        echo "[entrypoint]   -> set CLAUDE_HOST_DIR to point at your host's .claude directory." >&2
        exit 1
    fi
    echo "[entrypoint] seeding $CLAUDE_DIR + $CLAUDE_JSON from $SEED_CLAUDE_DIR / $SEED_CLAUDE_JSON"
    mkdir -p "$CLAUDE_DIR"
    cp "$SEED_CLAUDE_DIR/.credentials.json" "$CLAUDE_DIR/.credentials.json"
    chmod 600 "$CLAUDE_DIR/.credentials.json"

    # Drop host projects to avoid dead-link entries pointing at paths
    # that don't exist in-container. Seed a single /workspace project
    # so the UI has something to open on first boot. The snipeit MCP
    # entry is asserted below, unconditionally, on every boot.
    jq '{
        mcpServers: (.mcpServers // {}),
        projects: {"/workspace": {}}
    }' "$SEED_CLAUDE_JSON" > "$CLAUDE_JSON"
    chmod 600 "$CLAUDE_JSON"
fi

# Always re-assert the snipeit MCP entry pointing at the sibling
# container over docker DNS. Idempotent — protects against stale
# webui_home volumes seeded before this logic existed, or with an
# MCP_URL that has since changed.
tmp=$(mktemp)
jq --arg mcp_url "$MCP_URL_EFFECTIVE" \
    '.mcpServers = ((.mcpServers // {}) | .snipeit = {"type": "http", "url": $mcp_url})' \
    "$CLAUDE_JSON" > "$tmp" && mv "$tmp" "$CLAUDE_JSON"
chmod 600 "$CLAUDE_JSON"
echo "[entrypoint] snipeit MCP registered at $MCP_URL_EFFECTIVE"

# webui's /api/projects intersects .claude.json projects keys with
# actually-existing ~/.claude/projects/<encoded>/ dirs. It has no
# "add project" UI — both sides must exist for a project to show up.
mkdir -p "$CLAUDE_DIR/projects/-workspace"

exec "$@"
