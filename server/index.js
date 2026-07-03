// Roody credits proxy v2 — Node.js for Hostinger's GitHub deploy.
// Zero dependencies: Node 18+ built-ins only (http + fs + global fetch).
//
// Env vars (hPanel → your Node.js app → Environment variables):
//   GEMINI_API_KEY  = AIza...   (founder's key — server-side only)
//   ADMIN_KEY       = long random string — unlocks /admin
//   ROODY_CODES     = optional comma-separated bootstrap codes
//   DAILY_LIMIT     = default messages/day for env + generated codes (50)
//
// Codes now live in TWO places:
//   - env ROODY_CODES (survive everything, managed in hPanel)
//   - roody-data.json (minted in the /admin panel — name, limit, disabled;
//     survives restarts; may be lost on a full redeploy, so keep important
//     codes in the env var too)
// Daily usage counters are in-memory (reset on restart — fine at this scale).

const http = require("http");
const fs = require("fs");
const path = require("path");

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "50", 10);
const ENV_CODES = new Set(
  (process.env.ROODY_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);

// Only the models Roody uses — nobody farms the key as a general endpoint.
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-preview-tts"]);

// Approximate Gemini pricing, $ per 1M tokens — for the admin cost column.
const PRICE = {
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-preview-tts": { in: 0.50, out: 10.00 },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// ---- Dynamic codes (minted in the admin panel, persisted to disk) ----------
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, "roody-data.json");
let dyn = { codes: {} }; // { "ROODY-XXXX": { name, limit, disabled, created } }
try { dyn = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (_) {}
function saveDyn() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(dyn, null, 2)); } catch (e) { console.error("save failed:", e.message); }
}
function codeInfo(code) {
  if (dyn.codes[code]) {
    const c = dyn.codes[code];
    return c.disabled ? null : { name: c.name || "", limit: c.limit || DAILY_LIMIT, source: "panel" };
  }
  if (ENV_CODES.has(code)) return { name: "", limit: DAILY_LIMIT, source: "env" };
  return null;
}
function allCodes() {
  const list = [];
  for (const c of ENV_CODES) list.push({ code: c, ...( { name: "(env)", limit: DAILY_LIMIT, disabled: false, source: "env" } ) });
  for (const [c, v] of Object.entries(dyn.codes)) {
    list.push({ code: c, name: v.name || "", limit: v.limit || DAILY_LIMIT, disabled: !!v.disabled, source: "panel" });
  }
  return list;
}
function mintCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return "ROODY-" + s;
}

// ---- Usage stats (in-memory; metadata only, never conversation content) ----
const stats = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function statFor(code) {
  let s = stats.get(code);
  if (!s) {
    s = { day: today(), todayBrain: 0, todayTts: 0, todayStt: 0,
          allBrain: 0, allTts: 0, allStt: 0,
          inTok: 0, outTok: 0, costUSD: 0, lastUsed: null };
    stats.set(code, s);
  }
  if (s.day !== today()) { s.day = today(); s.todayBrain = 0; s.todayTts = 0; s.todayStt = 0; }
  return s;
}

function json(res, status, obj) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function esc(x) { return String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) { reject(new Error("too-big")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---- Admin dashboard --------------------------------------------------------
function adminPage(msg) {
  const k = encodeURIComponent(ADMIN_KEY);
  const rows = allCodes().map((c) => {
    const s = statFor(c.code);
    const actions = c.source === "panel"
      ? `<a href="/admin/toggle?key=${k}&code=${encodeURIComponent(c.code)}">${c.disabled ? "enable" : "disable"}</a>
         · <a href="/admin/del?key=${k}&code=${encodeURIComponent(c.code)}" onclick="return confirm('Delete ${esc(c.code)}?')">delete</a>`
      : `<span style="color:#a89880">env var</span>`;
    return `<tr${c.disabled ? ' style="opacity:.45"' : ""}>
      <td><b>${esc(c.code)}</b>${c.disabled ? " 🚫" : ""}</td>
      <td>${esc(c.name)}</td>
      <td>${s.todayBrain} / ${c.limit}</td>
      <td>${s.todayTts} · ${s.todayStt}</td>
      <td>${s.allBrain}</td>
      <td>$${s.costUSD.toFixed(4)} · ₹${(s.costUSD * 85).toFixed(2)}</td>
      <td>${s.lastUsed ? esc(new Date(s.lastUsed).toLocaleString()) : "—"}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
  const totalCost = [...stats.values()].reduce((a, s) => a + s.costUSD, 0);
  const totalToday = [...stats.values()].reduce((a, s) => a + (s.day === today() ? s.todayBrain : 0), 0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Roody Admin</title>
<style>body{font-family:system-ui,sans-serif;background:#1c1712;color:#f0e6da;max-width:1020px;margin:0 auto;padding:32px 16px}
h1{color:#e98a3c}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #3a3025}
th{color:#cbb59c;font-weight:600}a{color:#e98a3c}.k{background:#262019;border-radius:10px;padding:12px 16px;display:inline-block;margin:0 12px 16px 0}
form{background:#262019;border-radius:12px;padding:14px 16px;margin:8px 0 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input{background:#1c1712;border:1px solid #3a3025;color:#f0e6da;border-radius:8px;padding:8px 10px;font-size:14px}
button{background:#e98a3c;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
.msg{color:#7ec97e;font-weight:600;margin-bottom:10px}</style>
<meta http-equiv="refresh" content="60"></head><body>
<h1>🟠 Roody Admin</h1>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<div class="k">Messages today: <b>${totalToday}</b></div>
<div class="k">Total est. spend: <b>$${totalCost.toFixed(4)} · ₹${(totalCost * 85).toFixed(2)}</b></div>
<div class="k">Codes: <b>${allCodes().length}</b></div>
<form action="/admin/new" method="get">
  <input type="hidden" name="key" value="${esc(ADMIN_KEY)}">
  <b>🎟 New code:</b>
  <input name="name" placeholder="who is it for? (e.g. Priya)" required>
  <input name="limit" type="number" value="${DAILY_LIMIT}" min="1" max="1000" style="width:80px" title="messages/day">
  <button>Generate</button>
</form>
<table><tr><th>Code</th><th>Name</th><th>Today</th><th>TTS · STT</th><th>All-time</th><th>Est. cost</th><th>Last used</th><th></th></tr>${rows}</table>
<p style="color:#a89880;font-size:12px;margin-top:16px">Metadata only — conversations are never stored. Panel-minted codes persist to roody-data.json (survives restarts; a full redeploy may reset them — keep VIP codes in the ROODY_CODES env var too). Auto-refreshes every 60s.</p>
</body></html>`;
}

// ---- Server -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }

  if (req.method === "GET") {
    const u = new URL(req.url, "http://x");

    // User-facing usage check — powers the dashboard inside the extension.
    if (u.pathname === "/me") {
      const code = (u.searchParams.get("code") || "").trim().toUpperCase();
      const info = codeInfo(code);
      if (!info) return json(res, 403, { ok: false, error: "invalid-code" });
      const s = statFor(code);
      return json(res, 200, {
        ok: true, name: info.name, used: s.todayBrain, limit: info.limit,
        allTime: s.allBrain,
      });
    }

    // Public pages served from the repo.
    if (u.pathname === "/privacy" || u.pathname === "/privacy.html") {
      try {
        const html = fs.readFileSync(path.join(__dirname, "..", "site", "privacy.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (_) {}
    }
    if (u.pathname === "/roody" || u.pathname === "/index.html") {
      try {
        const html = fs.readFileSync(path.join(__dirname, "..", "site", "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (_) {}
    }

    // Admin — guarded by ADMIN_KEY.
    if (u.pathname.startsWith("/admin")) {
      if (!ADMIN_KEY || u.searchParams.get("key") !== ADMIN_KEY) {
        return json(res, 403, { error: "admin-key" });
      }
      const back = (m) => { res.writeHead(302, { location: `/admin?key=${encodeURIComponent(ADMIN_KEY)}&m=${encodeURIComponent(m)}` }); res.end(); };
      if (u.pathname === "/admin/new") {
        const code = mintCode();
        dyn.codes[code] = {
          name: (u.searchParams.get("name") || "").slice(0, 60),
          limit: Math.max(1, Math.min(1000, parseInt(u.searchParams.get("limit") || DAILY_LIMIT, 10) || DAILY_LIMIT)),
          disabled: false,
          created: Date.now(),
        };
        saveDyn();
        return back(`Created ${code} for ${dyn.codes[code].name || "—"}`);
      }
      if (u.pathname === "/admin/toggle") {
        const c = (u.searchParams.get("code") || "").trim().toUpperCase();
        if (dyn.codes[c]) { dyn.codes[c].disabled = !dyn.codes[c].disabled; saveDyn(); }
        return back(`${c} ${dyn.codes[c]?.disabled ? "disabled" : "enabled"}`);
      }
      if (u.pathname === "/admin/del") {
        const c = (u.searchParams.get("code") || "").trim().toUpperCase();
        if (dyn.codes[c]) { delete dyn.codes[c]; saveDyn(); }
        return back(`${c} deleted`);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(adminPage(u.searchParams.get("m") || ""));
    }

    // Health check.
    return json(res, 200, {
      ok: true,
      service: "roody-proxy",
      codes_loaded: allCodes().filter((c) => !c.disabled).length,
      daily_limit: DAILY_LIMIT,
      key_set: !!GEMINI_KEY,
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "method" });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "bad-json" });
  }
  const code = (payload.code || "").trim().toUpperCase();
  const { kind, model, body } = payload;

  if (!code || !model || !body) return json(res, 400, { error: "missing-fields" });
  if (!ALLOWED_MODELS.has(model)) return json(res, 400, { error: "model-not-allowed" });
  const info = codeInfo(code);
  if (!info) return json(res, 403, { error: "invalid-code" });
  if (!GEMINI_KEY) return json(res, 500, { error: "server-missing-key" });

  const s = statFor(code);

  // Brain calls burn a credit. TTS/STT ride along, but are capped at 3× the
  // daily limit so a scripted client can't drain the key through voice calls.
  if (kind === "brain") {
    if (s.todayBrain >= info.limit) {
      return json(res, 402, { error: "out-of-credits", used: s.todayBrain, limit: info.limit });
    }
    s.todayBrain += 1; s.allBrain += 1;
  } else if (kind === "tts") {
    if (s.todayTts >= info.limit * 3) return json(res, 402, { error: "voice-limit" });
    s.todayTts += 1; s.allTts += 1;
  } else if (kind === "stt") {
    if (s.todayStt >= info.limit * 3) return json(res, 402, { error: "voice-limit" });
    s.todayStt += 1; s.allStt += 1;
  }
  s.lastUsed = Date.now();

  // Forward to Gemini with the founder's key.
  let r, text;
  try {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify(body),
      }
    );
    text = await r.text();
  } catch (e) {
    return json(res, 502, { error: "gemini-unreachable", detail: String(e.message || e) });
  }

  // Cost accounting from Gemini's token counts (metadata only).
  try {
    const meta = JSON.parse(text)?.usageMetadata;
    if (meta) {
      const p = PRICE[model] || { in: 0, out: 0 };
      const inTok = meta.promptTokenCount || 0;
      const outTok = meta.candidatesTokenCount || 0;
      s.inTok += inTok; s.outTok += outTok;
      s.costUSD += (inTok * p.in + outTok * p.out) / 1e6;
    }
  } catch (_) {}

  res.writeHead(r.status, { ...CORS, "content-type": "application/json" });
  res.end(text);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`roody-proxy v2 on :${PORT} — env codes=${ENV_CODES.size} panel codes=${Object.keys(dyn.codes).length} key=${GEMINI_KEY ? "set" : "MISSING"} admin=${ADMIN_KEY ? "set" : "MISSING"}`);
});
