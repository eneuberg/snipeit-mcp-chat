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

const LISTEN_PORT = Number(process.env.PORT || 3583);
const LISTEN_HOST = process.env.HOST || "0.0.0.0";
const UPSTREAM = process.env.UPSTREAM || "http://127.0.0.1:8080";
const HOME = process.env.HOME;
const CLAUDE_JSON = `${HOME}/.claude.json`;
const PROJECTS_DIR = `${HOME}/.claude/projects`;

const INJECT = `/* injected by webui-proxy */
(() => {
  const SETTINGS_SEL = 'button[aria-label="Open settings"]';
  const ADD_LABEL = "Add project";
  const ADD_ICON = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" class="w-5 h-5 text-slate-600 dark:text-slate-400"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"/></svg>';

  const TA_SEL = 'textarea[placeholder^="Type message"]';
  const CLIP_LABEL = "Attach image";
  const CLIP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true" style="width:1.1rem;height:1.1rem;"><path stroke-linecap="round" stroke-linejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"/></svg>';
  const CLIP_BTN_CLASS = "px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg font-medium transition-all duration-200 shadow-sm hover:shadow-md text-sm";

  const setTextareaValue = (ta, v) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const addAddProjectButton = () => {
    const s = document.querySelector(SETTINGS_SEL);
    if (!s) return;
    if (s.parentElement && s.parentElement.dataset.extAddWrap === "1") return;
    const b = document.createElement("button");
    b.setAttribute("aria-label", ADD_LABEL);
    b.setAttribute("title", ADD_LABEL);
    b.className = s.className;
    b.innerHTML = ADD_ICON;
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
    const wrap = document.createElement("div");
    wrap.className = "flex items-center gap-3";
    wrap.dataset.extAddWrap = "1";
    s.replaceWith(wrap);
    wrap.appendChild(b);
    wrap.appendChild(s);
  };

  const addClipButton = () => {
    const tas = document.querySelectorAll(TA_SEL);
    tas.forEach((ta) => {
      if (ta.dataset.extClip === "1") return;
      const wrap = ta.parentElement;
      if (!wrap) return;
      if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
      ta.dataset.extClip = "1";
      // The textarea reserves pr-20 on the right for the send button;
      // mirror that on the left so typed text never slides under the
      // paperclip.
      ta.style.paddingLeft = "5rem";

      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.setAttribute("capture", "environment");
      input.style.display = "none";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", CLIP_LABEL);
      btn.setAttribute("title", CLIP_LABEL);
      btn.className = CLIP_BTN_CLASS;
      btn.innerHTML = CLIP_ICON;
      btn.style.cssText = "position:absolute;left:0.5rem;bottom:0.75rem;display:inline-flex;align-items:center;justify-content:center;z-index:10;";

      btn.onclick = () => input.click();
      input.onchange = async () => {
        const f = input.files && input.files[0];
        input.value = "";
        if (!f) return;
        const prev = btn.innerHTML;
        btn.innerHTML = "…";
        btn.disabled = true;
        try {
          const r = await fetch("/_ext/upload", {
            method: "POST",
            headers: {
              "Content-Type": f.type || "application/octet-stream",
              "X-Filename": encodeURIComponent(f.name || "image"),
            },
            body: f,
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || r.statusText);
          setTextareaValue(ta, ta.value + (ta.value ? "\\n" : "") + j.path);
          ta.focus();
        } catch (e) {
          alert("Upload failed: " + (e.message || e));
        } finally {
          btn.innerHTML = prev;
          btn.disabled = false;
        }
      };

      wrap.appendChild(input);
      wrap.appendChild(btn);
    });
  };

  const tick = () => { addAddProjectButton(); addClipButton(); };
  new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
  tick();
})();
`;

const PROJECTS_ROOT = "/workspace";
const UPLOADS_DIR = "/workspace/_uploads";
const MAX_UPLOAD = 25 * 1024 * 1024;
const ALLOWED_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"]);

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

function sanitiseFilename(name) {
  const base = path.basename(name || "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const trimmed = base.replace(/^[-.]+/, "").slice(0, 80);
  return trimmed || "image";
}

async function saveUpload(req) {
  const declaredLen = Number(req.headers["content-length"] || 0);
  if (declaredLen && declaredLen > MAX_UPLOAD) {
    const e = new Error(`file too large (max ${MAX_UPLOAD} bytes)`);
    e.status = 413;
    throw e;
  }
  const rawName = decodeURIComponent(req.headers["x-filename"] || "");
  const safe = sanitiseFilename(rawName);
  const ext = (safe.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    const e = new Error(`unsupported extension: ${ext || "(none)"}`);
    e.status = 400;
    throw e;
  }

  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_UPLOAD) {
      const e = new Error("file too large");
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }

  await mkdir(UPLOADS_DIR, { recursive: true });
  const finalPath = `${UPLOADS_DIR}/${Date.now()}-${safe}`;
  await writeFile(finalPath, Buffer.concat(chunks));
  return { path: finalPath };
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

function proxyRequest(req, res) {
  const target = new URL(UPSTREAM);
  
  const options = {
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host,
    },
  };

  const upstreamReq = http.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream error: " + err.message);
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
    if (req.url === "/_ext/upload" && req.method === "POST") {
      try {
        const result = await saveUpload(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(e.status || 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
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

for (const sig of ["SIGINT", "SIGTERM"]) {
  //process.on(sig, () => child.kill(sig));
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[proxy] listening on ${LISTEN_HOST}:${LISTEN_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});
