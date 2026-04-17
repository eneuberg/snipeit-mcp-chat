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

Configuration (OAuth session, MCP servers, project history) lives on the
host in `~/.claude/` + `~/.claude.json` and is bind-mounted into the webui
container read-write. Configure once with `claude login` / `claude mcp
add`, and it persists across rebuilds until you delete it.

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

### `webui/Dockerfile` (3 fixes)

1. **Pin a specific release and download the prebuilt binary.** `npm
   install -g claude-code-webui` is advertised but unreliable; the GitHub
   release ships Deno-compiled standalone binaries. Pick
   `claude-code-webui-linux-x64` or `-linux-arm64` via `WEBUI_ARCH`.

2. **Pass `--claude-path /usr/local/bin/claude` at startup.** webui's own
   PATH-based detection finds the CLI, but the embedded
   `@anthropic-ai/claude-code` SDK spawns it separately and fails with
   `ENOENT` unless the path is explicit.

3. **Symlink `node` into `/usr/bin`.** The SDK spawns `claude` (which has
   an `#!/usr/bin/env node` shebang) with a restricted PATH that doesn't
   include `/usr/local/bin`, so `env node` can't find the interpreter.
   Adding `/usr/bin/node → /usr/local/bin/node` makes the shebang resolve
   regardless of child env.

## `docker-compose.yml` quirks worth knowing

- **Bind-mount `~/.claude.json` as a file, not a dir.** webui reads this
  file directly. If the in-container target doesn't exist, Docker
  auto-creates a *directory* at that path and webui crashes with `EISDIR`.
  Our Dockerfile pre-creates an empty file; the compose mount then
  attaches to the file target.
- **Use absolute paths, not `${HOME}`.** snap-installed Docker resolves
  `${HOME}` to its private snap home (`/home/<user>/snap/docker/<rev>`),
  not the shell user's home. Anything using `${HOME}` will point at the
  wrong path or 404.
- **Mount the whole host home (`/home/admi:/home/admi`).** webui opens
  sessions at arbitrary working directories — the ones already in your
  host `~/.claude/projects/*.jsonl`. If the requested cwd doesn't exist
  inside the container, `claude` fails with a misleading `spawnSync ...
  ENOENT` (the *cwd* is missing, not the binary). Mounting your home
  path-exact avoids a long list of per-project bind mounts.

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
  API-key mode also works — see *Auth modes* below.

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
| `CLAUDE_HOST_DIR` | Host path of the `claude login`-authenticated `~/.claude`. Uncomment and set to an absolute path if `${HOME}` won't resolve correctly (snap Docker, Coolify). |

### 2. Pick the right webui architecture

In `webui/Dockerfile` the default is `WEBUI_ARCH=linux-x64`. On a Raspberry
Pi 4/5, change it to `linux-arm64` (or override at build time with
`--build-arg WEBUI_ARCH=linux-arm64`).

### 3. Deploy

```sh
docker compose up -d --build
```

### 4. Bind port 8080 to Tailscale only

`webui` uses `network_mode: host`, so `:8080` binds on every interface
including `tailscale0`. Block it on everything else:

```sh
sudo ufw allow in on tailscale0 to any port 8080
sudo ufw deny in to any port 8080
```

### 5. Open from your phone

Visit `http://<host-tailscale-name>:8080/`. Add to home screen. In the UI,
pick a working directory (e.g. `/home/<you>/snipeit-inventory` for the
pre-configured Snipe-IT prompt) and start chatting.

## Auth modes

- **Subscription (default).** `claude login` on the host, nothing else
  required. Rate-limits tuned for interactive use — fine for ad-hoc photos
  from your phone, not for bulk imports.
- **API key.** Put `ANTHROPIC_API_KEY=sk-ant-...` in `.env`. Pay-per-token.

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
a message.** Despite the path, this almost always means the *working
directory* you picked in the UI doesn't exist inside the container. Mount
the cwd path-exact (see "Mount the whole host home" above).

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
    └── Dockerfile       # sugyan/claude-code-webui release binary
                         #   + @anthropic-ai/claude-code CLI
                         #   + 3 patches for SDK spawn quirks
```

Both images build from source / upstream releases — no vendored forks.
Upstream fixes land on your next `docker compose build --no-cache`.
