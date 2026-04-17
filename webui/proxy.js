// Thin HTTP proxy in front of claude-code-webui. Adds an "Add project"
// button to the upstream React UI via HTML injection and exposes a
// helper endpoint that registers new projects (writes .claude.json +
// creates the encoded projects/ dir + mkdirs the target path).
//
// Upstream runs on 127.0.0.1:8079; this proxy binds 0.0.0.0:8080 so it
// takes over the tailnet-facing port without changing any compose/ufw
// config.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const UPSTREAM_PORT = 8079;
const LISTEN_PORT = Number(process.env.PORT || 8080);
const LISTEN_HOST = process.env.HOST || "0.0.0.0";
const HOME = process.env.HOME;
const CLAUDE_JSON = `${HOME}/.claude.json`;
const PROJECTS_DIR = `${HOME}/.claude/projects`;

const INJECT = `/* injected by webui-proxy */
(() => {
  const SEL = 'button[aria-label="Open settings"]';
  const LABEL = "Add project";
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" class="w-5 h-5 text-slate-600 dark:text-slate-400"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"/></svg>';
  const add = () => {
    const s = document.querySelector(SEL);
    if (!s) return;
    // Already wrapped? Nothing to do.
    if (s.parentElement && s.parentElement.dataset.extAddWrap === "1") return;
    const b = document.createElement("button");
    b.setAttribute("aria-label", LABEL);
    b.setAttribute("title", LABEL);
    b.className = s.className;
    b.innerHTML = ICON;
    b.onclick = async () => {
      const name = prompt("New project name:");
      if (!name) return;
      try {
        const r = await fetch("/_ext/add-project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (r.ok) location.reload();
        else alert("Failed: " + (await r.text()));
      } catch (e) {
        alert("Failed: " + e);
      }
    };
    // Wrap [add, settings] in a flex group so they sit together even
    // when the parent uses justify-between (project list page).
    const wrap = document.createElement("div");
    wrap.className = "flex items-center gap-3";
    wrap.dataset.extAddWrap = "1";
    s.replaceWith(wrap);
    wrap.appendChild(b);
    wrap.appendChild(s);
  };
  new MutationObserver(add).observe(document.body, { childList: true, subtree: true });
  add();
})();
`;

const PROJECTS_ROOT = "/workspace";

function validateName(n) {
  if (typeof n !== "string") return "name must be a string";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(n)) {
    return "name must be 1-64 chars: letters, digits, space, _ or -";
  }
  return null;
}

function encodeProjectName(p) {
  return p.replace(/\/$/, "").replace(/[/\\:._]/g, "-");
}

async function addProject(name) {
  const err = validateName(name);
  if (err) throw new Error(err);

  const targetPath = `${PROJECTS_ROOT}/${name}`;
  const encoded = encodeProjectName(targetPath);
  const raw = await readFile(CLAUDE_JSON, "utf8");
  const cfg = JSON.parse(raw);
  cfg.projects = cfg.projects || {};
  if (!cfg.projects[targetPath]) cfg.projects[targetPath] = {};

  const tmp = `${CLAUDE_JSON}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await rename(tmp, CLAUDE_JSON);

  await mkdir(`${PROJECTS_DIR}/${encoded}`, { recursive: true });
  await mkdir(targetPath, { recursive: true });

  return { encoded };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyRequest(req, res, { interceptHtml }) {
  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` };
  // When we need to rewrite the body, force identity so upstream doesn't
  // gzip/br it out from under us.
  if (interceptHtml) headers["accept-encoding"] = "identity";
  const upstreamReq = http.request(
    {
      host: "127.0.0.1",
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const ct = upstreamRes.headers["content-type"] || "";
      if (interceptHtml && ct.includes("text/html")) {
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          let body = Buffer.concat(chunks).toString("utf8");
          const tag = '<script src="/_ext/inject.js"></script>';
          if (body.includes("</body>") && !body.includes(tag)) {
            body = body.replace("</body>", `  ${tag}\n  </body>`);
          }
          const out = Buffer.from(body, "utf8");
          const outHeaders = { ...upstreamRes.headers };
          delete outHeaders["content-encoding"];
          outHeaders["content-length"] = String(out.length);
          res.writeHead(upstreamRes.statusCode, outHeaders);
          res.end(out);
        });
        upstreamRes.on("error", (e) => {
          res.writeHead(502);
          res.end("upstream error: " + e.message);
        });
      } else {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    },
  );
  upstreamReq.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream error: " + e.message);
  });
  req.pipe(upstreamReq);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/_ext/inject.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(INJECT);
      return;
    }
    if (req.url === "/_ext/add-project" && req.method === "POST") {
      const body = (await readBody(req)).toString("utf8");
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("invalid json");
        return;
      }
      try {
        const result = await addProject(data.name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message || e));
      }
      return;
    }
    const interceptHtml = req.method === "GET" && (req.url === "/" || req.url === "/index.html");
    proxyRequest(req, res, { interceptHtml });
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end("proxy error: " + (e.message || e));
  }
});

const child = spawn(
  "claude-code-webui",
  [
    "--host",
    "127.0.0.1",
    "--port",
    String(UPSTREAM_PORT),
    "--claude-path",
    "/usr/local/bin/claude",
  ],
  { stdio: "inherit" },
);
child.on("exit", (code, sig) => {
  console.error(`[proxy] upstream exited code=${code} sig=${sig}`);
  process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[proxy] listening on ${LISTEN_HOST}:${LISTEN_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});
