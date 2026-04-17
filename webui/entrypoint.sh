#!/bin/sh
set -e

CLAUDE_DIR=/home/node/.claude
CLAUDE_JSON=/home/node/.claude.json
SEED_CLAUDE_DIR=/seed/claude
SEED_CLAUDE_JSON=/seed/claude.json

# First-boot seed only. Copies OAuth creds + MCP config from the host
# read-only mounts into the container's named-volume home. Never
# overwrites existing container state, so refreshed tokens and session
# history persist across restarts.
#
# Fail-closed: if the named volume is empty AND the host seed is
# missing, exit 1 instead of booting a broken container (webui's
# /api/projects 500s loudly in that state, which is hard to diagnose).
if [ -f "$CLAUDE_JSON" ]; then
    echo "[entrypoint] $CLAUDE_JSON already present — using forked state in the named volume. Wipe webui_home to re-seed from the host."
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

    # Keep only MCP servers; seed a single /workspace project so the UI
    # has something to open on first boot. Drop host projects to avoid
    # dead-link entries pointing at paths that don't exist in-container.
    # Rewrite the snipeit MCP server URL to MCP_URL so the container
    # reaches MCP over docker DNS (snipeit-mcp:8000) instead of the
    # host-loopback URL baked into the host's config.
    jq --arg mcp_url "${MCP_URL:-http://snipeit-mcp:8000/mcp/}" '{
        mcpServers: (
            (.mcpServers // {})
            | if has("snipeit") then .snipeit.url = $mcp_url else . end
        ),
        projects: {"/workspace": {}}
    }' "$SEED_CLAUDE_JSON" > "$CLAUDE_JSON"
    chmod 600 "$CLAUDE_JSON"
fi

# webui's /api/projects intersects .claude.json projects keys with
# actually-existing ~/.claude/projects/<encoded>/ dirs. It has no
# "add project" UI — both sides must exist for a project to show up.
mkdir -p "$CLAUDE_DIR/projects/-workspace"

exec "$@"
