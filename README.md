# snipeit-chat-stack

Phone-friendly chat UI for Snipe-IT. Photograph an item, let Claude identify it
and fill out the Snipe-IT record via the MCP server.

Two containers, both internal to your Coolify host:

- `snipeit-mcp` — [jameshgordy/snipeit-mcp](https://github.com/jameshgordy/snipeit-mcp)
  built from source, run in HTTP transport. Talks to Snipe-IT over the
  internal Docker network.
- `snipeit-chat` — Chainlit app. Claude client with vision + MCP tool-use loop.
  The only service that publishes a port.

Nothing is exposed to the public internet. Access is meant to be Tailscale-only.

## Prerequisites

- Coolify host with an existing Snipe-IT container running.
- Snipe-IT API token (Snipe-IT → your profile → Manage API Tokens).
- Anthropic API key.
- Your Snipe-IT container reachable on the same Docker network as this stack
  (see Coolify step 3 below).

## Setup

1. Copy `.env.example` → `.env` and fill in every field.
   - `SNIPEIT_URL` must be the **Docker-internal** URL of Snipe-IT
     (e.g. `http://snipe-it:80`). Not the public one.
   - Generate `CHAINLIT_AUTH_SECRET` with
     `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

2. In Coolify, create a new "Docker Compose" resource pointing at this repo.
   Paste the env vars in the Coolify UI (don't commit `.env`).

3. Attach the existing Snipe-IT service to this stack's `internal` network:
   Coolify → Snipe-IT project → Networks → add `snipeit-chat-stack_internal`.
   Otherwise the MCP container can't reach Snipe-IT.

4. Bind `snipeit-chat`'s published port to your Tailscale interface only:
   - In Coolify, leave it with no public domain / no Cloudflare tunnel.
   - On the host, confirm that port 8000 is only bound on the Tailscale
     interface (either via Coolify's interface setting, or with a host
     firewall rule: `ufw allow in on tailscale0 to any port 8000`).

5. Deploy. Open `http://<your-tailscale-ip>:8000/` from your phone (while
   connected to the tailnet) and add it to the home screen for quick access.

## Verification

Run these in order:

1. **MCP server alive**
   ```sh
   docker compose exec snipeit-chat curl -sS http://snipeit-mcp:8000/mcp/
   ```
   Expect an MCP handshake error (405 / missing session header), not a
   connection refused. That proves HTTP transport is up.

2. **MCP → Snipe-IT reachability**
   ```sh
   docker compose exec snipeit-mcp \
     sh -c 'wget -qO- --header="Authorization: Bearer $SNIPEIT_TOKEN" $SNIPEIT_URL/api/v1/hardware | head -c 200'
   ```
   Expect JSON starting with `{"total":...}`. Proves env vars + internal DNS.

3. **Chat app, text only**
   Open the UI, ask: *"List the first 5 hardware assets and their status."*
   Expect a `manage_assets` (or similar) tool-use step to appear, then a
   summarized answer.

4. **Vision pipeline end-to-end**
   From your phone, attach a photo of a real item and say *"Add this to
   inventory."* Claude should ask for any fields it can't see (asset tag,
   location, serial), then call `manage_assets` with `action: create`.
   Verify the new asset appears in Snipe-IT's web UI.

5. **Persistence**
   Close the browser tab, reopen the UI. Previous conversation history
   should still be there, proving the SQLite data layer is wired up.

## Tweaks you might want later

- **Password auth**: set `CHAINLIT_AUTH_SECRET` (already wired) and add a
  `@cl.password_auth_callback` in `chat/app.py`.
- **Fewer tools**: trim `SNIPEIT_ALLOWED_TOOLS` in `.env` to reduce the tool
  schema sent on every Claude call.
- **Prompt caching**: wrap the `tools` array with `cache_control` in
  `app.py` if tool schemas are bloating your per-request cost.
- **Different model**: `ANTHROPIC_MODEL=claude-sonnet-4-6` is cheaper and
  faster; Opus is better at photo-to-structured-data.

## Layout

```
snipeit-chat-stack/
├── docker-compose.yml
├── .env.example
├── README.md
└── chat/
    ├── Dockerfile
    ├── pyproject.toml
    ├── app.py
    ├── chainlit.md
    └── .chainlit/config.toml
```

Upstream `snipeit-mcp` is consumed as-is via `build:` pointing at its GitHub
repo — no fork, no vendoring. Upstream fixes land on your next rebuild.
