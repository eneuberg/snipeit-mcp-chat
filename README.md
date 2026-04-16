# snipeit-chat-stack

Phone-friendly chat UI for Snipe-IT inventory, using your Claude Pro/Max
subscription (or an API key) through [CloudCLI](https://github.com/siteboon/claudecodeui).
Photograph an item, let Claude identify it and populate the Snipe-IT record
via the MCP server.

Designed to run on a Raspberry Pi via Coolify, reachable only over Tailscale.

## Architecture

Two containers, shared Docker network:

- **`snipeit-mcp`** — wraps [jameshgordy/snipeit-mcp](https://github.com/jameshgordy/snipeit-mcp)
  with the patches below. Exposes Snipe-IT's API as 38 MCP tools over
  Streamable-HTTP. Talks to your existing Snipe-IT instance over HTTP.
- **`cloudcli`** — [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui),
  a mobile-first web UI for Claude Code. Reads `/home/appuser/.claude` for
  your OAuth session, connects to `snipeit-mcp` via the internal network,
  serves the web UI on port 3001. This is the only container that publishes
  a port — bind it to your Tailscale interface.

Nothing is exposed to the public internet.

## Upstream bugs we patch

Three fixes live in `mcp/Dockerfile`:

1. **Pin `fastmcp==2.12.4`** — upstream's `uv.lock` pins this version, but
   their Dockerfile does `uv pip install .` which ignores the lockfile and
   pulls the latest. Newer `fastmcp` removed the `_tool_manager` internal
   attribute that upstream's `server.py` references (around line 5410), so
   the server crashes on startup.

2. **Launch via `python -c "from server import mcp; mcp.run(...)"`** — the
   upstream runtime image doesn't put the `fastmcp` CLI on `PATH`. We skip
   it and call `mcp.run(transport='http', host='0.0.0.0', port=8000)`
   directly.

3. **Patch `snipeit-api` URL validation** — the `lfctech/snipeit-python-api`
   client library (used by most tool functions) has a hard check:
   ```python
   if not url.startswith("https://") and not url.startswith("http://localhost"):
       raise ValueError("URL must start with https:// or http://localhost")
   ```
   Any plain-`http://` Snipe-IT URL (e.g. a Tailscale-internal hostname)
   breaks every tool that goes through that client. `manage_status_labels`
   happens to bypass the client and works fine — so tools fail inconsistently,
   which can mislead Claude into inventing explanations ("the MCP server only
   allows HTTPS"). Our Dockerfile rewrites `"http://localhost"` →
   `"http://"` in `client.py` at build time, accepting any HTTP URL.

## Prerequisites

- Raspberry Pi running Coolify, or any Linux host with Docker + Docker Compose.
- Existing Snipe-IT instance reachable on the same Docker network (or via
  Tailscale). Get a permanent API token from its web UI → your profile →
  *Manage API Tokens*.
- Tailscale installed on the host and on your phone.
- A **Claude Pro/Max subscription** on the host: run `claude login` once
  (install the CLI from https://docs.anthropic.com/en/docs/claude-code if
  you don't have it). The resulting `~/.claude/.credentials.json` is what
  the container bind-mounts.
  (API-key mode also works — see below.)

## Setup

### 1. Copy and fill `.env`

```sh
cp .env.example .env
$EDITOR .env
```

Fields:

| Variable | What |
|---|---|
| `SNIPEIT_URL` | Docker-internal Snipe-IT URL (e.g. `http://snipe-it:80`) or Tailscale hostname — not the public one. |
| `SNIPEIT_TOKEN` | Snipe-IT API token. |
| `SNIPEIT_ALLOWED_TOOLS` | Comma-separated MCP tool whitelist (defaults to a safe curated set — see `.env.example`). |
| `CLAUDE_HOST_DIR` | Host path holding a `claude login`-authenticated `~/.claude`. Default `${HOME}/.claude`. |

### 2. Attach Snipe-IT to this stack's network (Coolify only)

The MCP container reaches Snipe-IT by Docker DNS. In Coolify:
**Snipe-IT project → Networks → add `snipeit-chat-stack_internal`.**
Without this, the MCP container can't resolve the Snipe-IT service name.

### 3. Deploy

```sh
docker compose up -d --build
```

First build takes ~5 min on a Pi 4 (`npm install` for CloudCLI dominates).

### 4. Bind the CloudCLI port to Tailscale only

CloudCLI publishes port 3001. In Coolify: leave the service with no public
domain / no Cloudflare tunnel. On the host:

```sh
sudo ufw allow in on tailscale0 to any port 3001
sudo ufw deny in to any port 3001
```

Or have Coolify bind it to the `tailscale0` interface.

### 5. Open from your phone

On the tailnet, visit `http://<host-tailscale-name>:3001/`. Add it to your
home screen.

The pre-configured project `snipeit-inventory` has a `CLAUDE.md` with the
inventory workflow baked in — open it in CloudCLI and start chatting.

## Auth modes

**Subscription (default).** `claude login` on the host, nothing else needed.
Rate limits are tuned for interactive use — fine for ad-hoc photos from your
phone, not for bulk imports.

**API key.** Put `ANTHROPIC_API_KEY=sk-ant-...` in `.env` and set
`AUTH_MODE=api_key` (see `.env.example`). Pay-per-token billing.

## Verification

After `docker compose up -d --build`:

```sh
# 1. MCP server alive
docker compose logs snipeit-mcp --tail=20
# Expect "Uvicorn running on http://0.0.0.0:8000"

# 2. MCP → Snipe-IT connectivity (token + URL valid)
docker compose exec snipeit-mcp python3 -c "
import os, urllib.request
u = os.environ['SNIPEIT_URL'].rstrip('/') + '/api/v1/statuslabels'
req = urllib.request.Request(u, headers={
  'Authorization': 'Bearer ' + os.environ['SNIPEIT_TOKEN'],
  'Accept': 'application/json'})
print(urllib.request.urlopen(req, timeout=10).status)
"
# Expect 200

# 3. CloudCLI alive
curl -sI http://127.0.0.1:3001/ | head -1
# Expect HTTP 200

# 4. Open the UI, open the snipeit-inventory project, ask "list categories"
#    Expect a mcp__snipeit__manage_categories tool-use step with real data.
```

## Troubleshooting

**"URL must start with https:// or http://localhost"** on some tool calls
but not others — the URL patch (bug #3 above) didn't take effect. Rebuild
the MCP image: `docker compose build --no-cache snipeit-mcp`.

**CloudCLI says "Still connecting..."** repeatedly — the MCP HTTP session
dropped. Restart the MCP service: `docker compose restart snipeit-mcp`.
The Streamable-HTTP transport is new; transient reconnects happen.

**CloudCLI says "Not logged in / please run /login"** — the `~/.claude`
mount is empty or permission-blocked. Common causes:
- Host used `sudo` for `docker compose up`, which resets `$HOME` to `/root`;
  the bind points at `/root/.claude` which doesn't exist. Set
  `CLAUDE_HOST_DIR=/home/<youruser>/.claude` in `.env` so it's absolute.
- Container UID doesn't match host UID-1000. Our Dockerfile pins UID 1000.
  On a Pi, check `id -u` for the user who ran `claude login`.
- `~/.claude/.credentials.json` is mode 600 owned by the wrong user.

**Claude invents error messages that don't match reality** — especially
plausible-sounding ones like "the MCP only allows HTTPS" or "status label
not found." Always look at the **raw tool result**, not Claude's narration.
If the raw result is `{"success": true, ...}`, the tool worked and Claude
is confabulating.

**`status_summary` returns `{"status":"error","messages":"Statuslabel not found"}`**
— upstream bug in the MCP, unrelated to your Snipe-IT data. Ignore.

## Layout

```
snipeit-chat-stack/
├── docker-compose.yml
├── .env.example
├── README.md
├── mcp/
│   └── Dockerfile           # wraps jameshgordy/snipeit-mcp + 3 patches
└── cloudcli/
    ├── Dockerfile           # runs siteboon/claudecodeui
    └── claude.md            # baked-in system prompt for the inventory project
```

Both containers build from source — no vendored forks. Upstream fixes land
on your next `docker compose build --no-cache`.
