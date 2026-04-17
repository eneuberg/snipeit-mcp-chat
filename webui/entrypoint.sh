#!/bin/sh
set -e

CLAUDE_DIR=/home/node/.claude
CLAUDE_JSON=/home/node/.claude.json

# First-boot seed only. Copies OAuth creds + MCP config from the host
# read-only mounts into the container's named-volume home. Never
# overwrites existing container state, so refreshed tokens and session
# history persist across restarts.
if [ ! -f "$CLAUDE_DIR/.credentials.json" ] && [ -f /seed/claude/.credentials.json ]; then
    mkdir -p "$CLAUDE_DIR"
    cp /seed/claude/.credentials.json "$CLAUDE_DIR/.credentials.json"
    chmod 600 "$CLAUDE_DIR/.credentials.json"
fi

if [ ! -f "$CLAUDE_JSON" ] && [ -f /seed/claude.json ]; then
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
    }' /seed/claude.json > "$CLAUDE_JSON"
    chmod 600 "$CLAUDE_JSON"
fi

# webui's /api/projects intersects .claude.json projects keys with
# actually-existing ~/.claude/projects/<encoded>/ dirs. It has no
# "add project" UI — both sides must exist for a project to show up.
mkdir -p "$CLAUDE_DIR/projects/-workspace"

exec "$@"
