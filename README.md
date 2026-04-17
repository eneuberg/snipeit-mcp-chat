# snipeit-chat-stack

Phone-friendly chat UI for [Snipe-IT](https://snipeitapp.com/) inventory,
using your Claude Pro/Max subscription (or an API key) through
[sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui).
Photograph an item, let Claude identify it and populate the Snipe-IT record
via MCP.

Runs on any Docker host — developed on Ubuntu with snap Docker, should also
work on a Raspberry Pi. The UI is reachable only over Tailscale; nothing is
exposed to the public internet.

## Architecture

Two containers:

- **`snipeit-mcp`** — wraps [jameshgordy/snipeit-mcp](https://github.com/jameshgordy/snipeit-mcp)
  with the patches listed below. Exposes Snipe-IT's API as MCP tools over
  Streamable-HTTP. Published on `127.0.0.1:8765` only (not tailnet-reachable).
- **`webui`** — [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui)
  with the patches listed below. Shells out to the `claude` CLI (bundled in
  the image) which talks to `snipeit-mcp` using the MCP config in your
  host's `~/.claude.json`. Uses `network_mode: host` and listens on `:8080`
  so the loopback MCP URL resolves identically in-container and the UI is
  reachable on the tailnet interface.

The host's `~/.claude/` + `~/.claude.json` are bind-mounted read-only at
`/seed/` inside the container. On first boot the entrypoint copies
OAuth credentials and MCP server configuration into a named Docker volume
(`webui_home`); from then on the container owns its own state. A second
named volume (`webui_workspace`, mounted at `/workspace`) is the only
scratch filesystem chat sessions can write to — the host home is not
exposed. Configure once with `claude login` / `claude mcp add` before
first build, and the container inherits it.

## Upstream bugs we patch

### `mcp/Dockerfile` (3 fixes)

1. **Pin `fastmcp==2.12.4`.** Upstream's `uv.lock` pins this version, but
   their Dockerfile does `uv pip install .` which ignores the lockfile and
   pulls the latest. Newer `fastmcp` removed the `_tool_manager` attribute
   that upstream's `server.py` references, so the server crashes on start.

2. **Launch with `python -c "from server import mcp; mcp.run(...)"`.** The
   upstream runtime image doesn't have the `fastmcp` CLI on PATH.

3. **Patch `snipeit-api` URL validation.** The `lfctech/snipeit-python-api`
   client (used by most tool functions) hard-rejects plain `http://` URLs:
   ```python
   if not url.startswith("https://") and not url.startswith("http://localhost"):
       raise ValueError("URL must start with https:// or http://localhost")
   ```
   Our Dockerfile rewrites `"http://localhost"` → `"http://"` in
   `client.py` at build time, accepting any HTTP URL. Without this, tools
   fail inconsistently (some bypass the client and work, some don't), and
   Claude tends to invent plausible-sounding explanations about it.

### `webui/Dockerfile` (3 fixes + 1 feature)

1. **Pin a specific release and download the prebuilt binary.** `npm
   install -g claude-code-webui` is advertised but unreliable; the GitHub
   release ships Deno-compiled standalone binaries. We pick between
   `claude-code-webui-linux-x64` and `-linux-arm64` automatically from
   BuildKit's `TARGETARCH` (falls back to `dpkg --print-architecture`
   for non-buildx builds), so the same Dockerfile works on x86_64 and
   on Raspberry Pi 4/5 without editing anything.

2. **Pass `--claude-path /usr/local/bin/claude` at startup.** webui's own
   PATH-based detection finds the CLI, but the embedded
   `@anthropic-ai/claude-code` SDK spawns it separately and fails with
   `ENOENT` unless the path is explicit.

3. **Symlink `node` into `/usr/bin`.** The SDK spawns `claude` (which has
   an `#!/usr/bin/env node` shebang) with a restricted PATH that doesn't
   include `/usr/local/bin`, so `env node` can't find the interpreter.
   Adding `/usr/bin/node → /usr/local/bin/node` makes the shebang resolve
   regardless of child env.

4. **Ship `proxy.js` as the container CMD.** webui has no "Add project"
   UI and its `/api/projects` endpoint requires an entry both in
   `~/.claude.json` and as an encoded dir under `~/.claude/projects/`.
   Our `webui/proxy.js` is a ~150-line Node script that binds `:8080`,
   spawns `claude-code-webui` internally on `127.0.0.1:8079`, forwards
   all traffic, and:
   - Injects a `<script src="/_ext/inject.js">` tag into the HTML
     response for `/`. The script uses a MutationObserver to find the
     existing "Open settings" button and insert a matching `+` button
     next to it.
   - Serves `POST /_ext/add-project` which validates the path, edits
     `~/.claude.json` (`projects[path] = {}`), creates the encoded
     `~/.claude/projects/<encoded>/` dir, and `mkdir -p`s the path
     itself so chat sessions can `cd` into it without ENOENT.

   No upstream fork — delete `proxy.js` and revert the `CMD` line to
   fall back to plain upstream behaviour.

## Volume layout

- **`webui_home:/home/node`** — persistent container home. Holds the
  OAuth credentials (copy of host's at first boot, refreshed
  independently afterward), MCP config, and session history.
- **`webui_workspace:/workspace`** — scratch filesystem chat sessions
  write to. Survives container restarts.
- **`${CLAUDE_HOST_DIR:-${HOME}/.claude}:/seed/claude:ro`** and
  **`${CLAUDE_CONFIG_FILE:-${HOME}/.claude.json}:/seed/claude.json:ro`**
  — read-only seed mounts. The entrypoint (`webui/entrypoint.sh`) reads
  from these *only* on first boot to populate `webui_home`. Never
  written to. Both default to the invoking shell's `${HOME}`; override
  in `.env` if that's wrong for your setup (snap Docker, Coolify, sudo).

The host home is otherwise not visible inside the container. Use
`/workspace` as the working directory when starting a new chat in the UI.

### Why this shape

- **Named volume, not bind-mount, for state.** Session history and any
  refreshed OAuth tokens are isolated from the host — the host's
  `~/.claude` never changes regardless of what happens in the container.
- **Read-only seed.** Even if webui were compromised, it can't modify
  your real credentials or MCP config.
- **jq filter on `.claude.json` seed.** Only the `mcpServers` key is
  copied; the host `projects` list is dropped so host paths don't
  appear as dead links inside the container.
- **`${HOME}` defaults with `.env` override.** Snap-installed Docker
  resolves `${HOME}` to its private snap home
  (`/home/<user>/snap/docker/<rev>`), not the shell user's home. If
  that's you, set `CLAUDE_HOST_DIR` and `CLAUDE_CONFIG_FILE` to
  absolute paths in `.env`.

## Prerequisites

- Linux host with Docker + Docker Compose. For snap Docker, your user
  needs to be in the `docker` group:
  ```sh
  sudo groupadd -f docker && sudo usermod -aG docker $USER \
    && sudo snap disable docker && sudo snap enable docker && newgrp docker
  ```
- Existing Snipe-IT instance reachable from the host. Get a permanent API
  token via its web UI → your profile → *Manage API Tokens*.
- Tailscale on the host and on your phone.
- A **Claude Pro/Max subscription**: run `claude login` once on the host
  (install from https://docs.anthropic.com/en/docs/claude-code), then:
  ```sh
  claude mcp add --transport http snipeit http://127.0.0.1:8765/mcp/
  ```

## Setup

### 1. Configure `.env`

```sh
cp .env.example .env
$EDITOR .env
```

| Variable | What |
|---|---|
| `SNIPEIT_URL` | Snipe-IT base URL the MCP container will reach. Any `http://` or `https://` URL works (patch #3 above). |
| `SNIPEIT_TOKEN` | Snipe-IT API token. |
| `SNIPEIT_ALLOWED_TOOLS` | MCP tool whitelist. Default in `.env.example` is a curated read/write set without destructive admin ops. |
| `CLAUDE_HOST_DIR` | Host path of the `claude login`-authenticated `~/.claude`. Defaults to `${HOME}/.claude`; override only if `${HOME}` won't resolve correctly (snap Docker, Coolify). |
| `CLAUDE_CONFIG_FILE` | Host path of `~/.claude.json`. Defaults to `${HOME}/.claude.json`. Same override rule. |

### 2. Deploy

```sh
docker compose up -d --build
```

### 3. Bind port 8080 to Tailscale only

`webui` uses `network_mode: host`, so `:8080` binds on every interface
including `tailscale0`. Block it on everything else:

```sh
sudo ufw allow in on tailscale0 to any port 8080
sudo ufw deny in to any port 8080
```

### 4. Open from your phone

Visit `http://<host-tailscale-name>:8080/`. Add to home screen. In the UI,
start a new chat with `/workspace` as the working directory (it's the
only one the container can write to). Host paths are intentionally not
mounted.

To add more working directories, use the `+` button in the UI header
(next to the gear icon) and enter an absolute path, e.g.
`/workspace/inventory`. The button is provided by `webui/proxy.js` — it
writes to `~/.claude.json`, creates the encoded project dir, and
`mkdir -p`s the path so the session can open it immediately.

To attach a photo, use the paperclip button inside the chat input. On
mobile it opens the camera directly; on desktop it opens the file
picker. The image is uploaded to `/workspace/_uploads/` and its
absolute path is appended to your message — Claude reads it via its
`Read` tool. Two MCP hooks land the photo in Snipe-IT itself:

- `asset_files` — ask "attach this to asset 42" → shows up on the
  asset's **Files** tab.
- `asset_thumbnail` — ask "use this as the thumbnail of asset 42" →
  replaces the asset's main image (header + list views). This one is
  a local extension on top of upstream snipeit-mcp (see
  `mcp/asset_thumbnail_tool.py`).

Prune uploads with
`docker compose exec webui rm -rf /workspace/_uploads/*`.

## Cheat sheet

Everyday ops — all run from the repo root on the Docker host.

**Full re-seed of Claude state** (after `claude login` or when tokens
look stale — wipes credentials, MCP config, session history; keeps
`/workspace`):
```sh
docker compose down
docker volume rm snipeit-chat-stack_webui_home
docker compose up -d
```

**Pull in just updated MCP servers** (after `claude mcp add` on host):
```sh
docker compose exec webui sh -c \
  'jq --argjson h "$(jq .mcpServers /seed/claude.json)" \
      ".mcpServers = \$h" /home/node/.claude.json > /tmp/j && \
   mv /tmp/j /home/node/.claude.json'
docker compose restart webui
```

**Restart / rebuild**:
```sh
docker compose restart webui                 # just bounce
docker compose up -d --build webui           # rebuild image + restart
docker compose up -d --build --force-recreate  # full rebuild both services
```

**Logs**:
```sh
docker compose logs -f webui --tail=50       # follow
docker compose logs snipeit-mcp --tail=50    # MCP server
```

**Shell into the container**:
```sh
docker compose exec webui bash
docker compose exec snipeit-mcp bash
```

**Inspect / edit Claude state live**:
```sh
docker compose exec webui jq .mcpServers /home/node/.claude.json
docker compose exec webui jq '.projects | keys' /home/node/.claude.json
```

**Projects** — remove one:
```sh
docker compose exec webui sh -c \
  'jq "del(.projects[\"/workspace/NAME\"])" /home/node/.claude.json > /tmp/j && \
   mv /tmp/j /home/node/.claude.json && \
   rm -rf /home/node/.claude/projects/-workspace-NAME'
```

**Prune uploaded photos**:
```sh
docker compose exec webui rm -rf /workspace/_uploads/*
```

**Nuclear wipe** (everything including `/workspace` contents — photos,
project files, chat history):
```sh
docker compose down -v
docker compose up -d --build
```

**Host `claude` sanity-check** (confirms your host login works before
re-seeding the container):
```sh
claude --version
claude mcp list
ls -la ~/.claude/.credentials.json ~/.claude.json
```

If after a re-seed the UI still says "Not logged in", the problem is on
the host side — the read-only seed mounts in `docker-compose.yml` point
at paths that don't contain a fresh `.credentials.json`. Check `$HOME`
in the shell you ran `docker compose` in, and override
`CLAUDE_HOST_DIR` / `CLAUDE_CONFIG_FILE` in `.env` if needed.

## Auth

Auth is subscription-only: `claude login` on the host, nothing else
required. Rate-limits tuned for interactive use — fine for ad-hoc photos
from your phone, not for bulk imports. API-key auth isn't wired up — the
chat container uses the bundled Claude Code CLI against the OAuth session
copied in from the seed mount, and neither `docker-compose.yml` nor the
entrypoint reads `ANTHROPIC_API_KEY`.

## Verification

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

# 3. webui alive
curl -sI http://127.0.0.1:8080/ | head -1
# Expect HTTP/1.1 200 OK

# 4. End-to-end: open the UI, ask "list categories".
#    Expect a mcp__snipeit__manage_categories tool call with real data.
```

## Troubleshooting

**`webui` logs show `spawnSync /usr/local/bin/claude ENOENT` when you send
a message.** Misleading error: the *working directory* you picked in the
UI doesn't exist inside the container. Only `/workspace` is writable;
host paths from outside the container won't resolve.

**URL validation errors on some tools but not others.** The MCP client
patch (bug #3) didn't take effect — rebuild with `docker compose build
--no-cache snipeit-mcp`.

**webui says "Still connecting..." repeatedly.** The MCP Streamable-HTTP
session dropped. `docker compose restart snipeit-mcp`.

**webui says "Not logged in / please run /login".** `~/.claude` mount is
empty or permission-blocked. Common causes:
- You ran `docker compose` under `sudo`, which reset `$HOME` to `/root`.
  Set `CLAUDE_HOST_DIR=/home/<you>/.claude` in `.env`.
- You're on snap Docker and `${HOME}` resolved to the snap's private home
  — use an absolute path in `CLAUDE_HOST_DIR`.
- Container UID ≠ 1000, so bind-mounted credentials are unreadable. The
  webui image uses the stock node:22-slim `node` user (UID 1000); check
  your host `id -u` matches.

**Host group change doesn't propagate to an already-running shell.** After
`newgrp docker`, only that shell sees the new group. For any long-lived
process (IDE, Claude Code, etc.), exit and relaunch from a shell where
`id` shows `docker`, or log out and back in.

**Claude invents error messages that don't match reality.** Especially
plausible-sounding ones like "the MCP only allows HTTPS" or "status label
not found." Always look at the **raw tool result**, not Claude's
narration. If the raw result is `{"success": true, ...}`, the tool worked
and Claude is confabulating.

**`status_summary` returns `"Statuslabel not found"`.** Upstream MCP bug
unrelated to your Snipe-IT data. Ignore.

## Layout

```
snipeit-chat-stack/
├── docker-compose.yml
├── .env.example
├── README.md
├── mcp/
│   └── Dockerfile       # jameshgordy/snipeit-mcp + 3 patches
└── webui/
    ├── Dockerfile       # sugyan/claude-code-webui release binary
    │                    #   + @anthropic-ai/claude-code CLI
    │                    #   + 3 patches for SDK spawn quirks
    ├── entrypoint.sh    # first-boot seed of OAuth + MCP config from
    │                    #   read-only /seed bind-mounts
    └── proxy.js         # injects an "Add project" button into the UI
                         #   and exposes /_ext/add-project
```

Both images build from source / upstream releases — no vendored forks.
Upstream fixes land on your next `docker compose build --no-cache`.
