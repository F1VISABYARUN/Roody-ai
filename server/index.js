// Roody credits proxy — Node.js version for Hostinger's GitHub deploy.
// Zero dependencies: Node 18+ built-ins only (http + global fetch).
//
// Env vars (set in hPanel → your Node.js app → Environment variables):
//   GEMINI_API_KEY  = AIza...              (founder's key — server-side only)
//   ROODY_CODES     = ROODY-AAA,ROODY-BBB  (comma-separated invite codes)
//   DAILY_LIMIT     = 50                   (messages per code per day)
//
// v1 keeps daily counters in memory — restarts reset them, which is fine for
// a handful of trusted testers. Swap in MySQL when real users arrive.

const http = require("http");

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const CODES = new Set(
  (process.env.ROODY_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "50", 10);

// Only the models Roody uses — nobody farms the key as a general endpoint.
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-preview-tts"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// Admin access — set ADMIN_KEY to a long random string in hPanel env vars.
// The dashboard at /admin?key=... shows usage METADATA only (counts, costs,
// timestamps) — never conversation content, per the privacy policy.
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Approximate Gemini pricing, $ per 1M tokens — for the admin cost column.
const PRICE = {
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-preview-tts": { in: 0.50, out: 10.00 },
};

// code -> per-user stats (in-memory; resets on restart — env vars stay the
// source of truth for which codes exist).
// { day, todayBrain, todayTts, todayStt, allBrain, allTts, allStt,
//   inTok, outTok, costUSD, lastUsed, disabled }
const stats = new Map();
const today = () => new Date().toISOString().slice(0, 10);

function statFor(code) {
  let s = stats.get(code);
  if (!s) {
    s = { day: today(), todayBrain: 0, todayTts: 0, todayStt: 0,
          allBrain: 0, allTts: 0, allStt: 0,
          inTok: 0, outTok: 0, costUSD: 0, lastUsed: null, disabled: false };
    stats.set(code, s);
  }
  if (s.day !== today()) { s.day = today(); s.todayBrain = 0; s.todayTts = 0; s.todayStt = 0; }
  return s;
}

function esc(x) { return String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function adminPage() {
  const rows = [...CODES].map((code) => {
    const s = statFor(code);
    return `<tr${s.disabled ? ' style="opacity:.45"' : ""}>
      <td><b>${esc(code)}</b>${s.disabled ? " 🚫" : ""}</td>
      <td>${s.todayBrain} / ${DAILY_LIMIT}</td>
      <td>${s.todayTts} · ${s.todayStt}</td>
      <td>${s.allBrain} / ${s.allTts} / ${s.allStt}</td>
      <td>${(s.inTok + s.outTok).toLocaleString()}</td>
      <td>$${s.costUSD.toFixed(4)} · ₹${(s.costUSD * 85).toFixed(2)}</td>
      <td>${s.lastUsed ? esc(new Date(s.lastUsed).toLocaleString()) : "—"}</td>
      <td><a href="/admin/toggle?key=${encodeURIComponent(ADMIN_KEY)}&code=${encodeURIComponent(code)}">${s.disabled ? "enable" : "disable"}</a></td>
    </tr>`;
  }).join("");
  const totalCost = [...stats.values()].reduce((a, s) => a + s.costUSD, 0);
  const totalToday = [...stats.values()].reduce((a, s) => a + (s.day === today() ? s.todayBrain : 0), 0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Roody Admin</title>
<style>body{font-family:system-ui,sans-serif;background:#1c1712;color:#f0e6da;max-width:960px;margin:0 auto;padding:32px 16px}
h1{color:#e98a3c}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #3a3025}
th{color:#cbb59c;font-weight:600}a{color:#e98a3c}.k{background:#262019;border-radius:10px;padding:12px 16px;display:inline-block;margin:0 12px 16px 0}</style>
<meta http-equiv="refresh" content="30"></head><body>
<h1>🟠 Roody Admin</h1>
<div class="k">Messages today: <b>${totalToday}</b></div>
<div class="k">Total est. spend: <b>$${totalCost.toFixed(4)} · ₹${(totalCost * 85).toFixed(2)}</b></div>
<div class="k">Daily limit: <b>${DAILY_LIMIT}</b>/code</div>
<table><tr><th>Code</th><th>Today</th><th>TTS · STT today</th><th>All-time B/T/S</th><th>Tokens</th><th>Est. cost</th><th>Last used</th><th></th></tr>${rows}</table>
<p style="color:#a89880;font-size:12px;margin-top:16px">Metadata only — conversations are never stored. Disable/enable here lasts until the app restarts; permanent changes = edit ROODY_CODES env var. Auto-refreshes every 30s.</p>
</body></html>`;
}

function json(res, status, obj) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }

  if (req.method === "GET") {
    // Public pages served straight from the repo (the app deploys with it):
    // /privacy → the policy URL the Chrome Web Store listing requires.
    if (req.url === "/privacy" || req.url === "/privacy.html") {
      try {
        const html = require("fs").readFileSync(require("path").join(__dirname, "..", "site", "privacy.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (_) { /* fall through to health check */ }
    }
    if (req.url === "/roody" || req.url === "/index.html") {
      try {
        const html = require("fs").readFileSync(require("path").join(__dirname, "..", "site", "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (_) { /* fall through */ }
    }
    // Admin dashboard — metadata only, guarded by ADMIN_KEY.
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/admin" || u.pathname === "/admin/toggle") {
      if (!ADMIN_KEY || u.searchParams.get("key") !== ADMIN_KEY) {
        return json(res, 403, { error: "admin-key" });
      }
      if (u.pathname === "/admin/toggle") {
        const c = (u.searchParams.get("code") || "").trim().toUpperCase();
        if (CODES.has(c)) { const s = statFor(c); s.disabled = !s.disabled; }
        res.writeHead(302, { location: `/admin?key=${encodeURIComponent(ADMIN_KEY)}` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(adminPage());
    }
    // Health check — open the root URL to see the proxy is alive.
    return json(res, 200, {
      ok: true,
      service: "roody-proxy",
      codes_loaded: CODES.size,
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
  if (!CODES.has(code)) return json(res, 403, { error: "invalid-code" });
  if (!GEMINI_KEY) return json(res, 500, { error: "server-missing-key" });

  const s = statFor(code);
  if (s.disabled) return json(res, 403, { error: "invalid-code" });

  // Brain calls burn a credit; tts/stt ride along on a valid code.
  if (kind === "brain") {
    if (s.todayBrain >= DAILY_LIMIT) {
      return json(res, 402, { error: "out-of-credits", used: s.todayBrain, limit: DAILY_LIMIT });
    }
    s.todayBrain += 1; s.allBrain += 1;
  } else if (kind === "tts") { s.todayTts += 1; s.allTts += 1; }
  else if (kind === "stt") { s.todayStt += 1; s.allStt += 1; }
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

  // Cost accounting from Gemini's own token counts (metadata only — the
  // response content is passed through, never stored).
  try {
    const meta = JSON.parse(text)?.usageMetadata;
    if (meta) {
      const p = PRICE[model] || { in: 0, out: 0 };
      const inTok = meta.promptTokenCount || 0;
      const outTok = meta.candidatesTokenCount || 0;
      s.inTok += inTok; s.outTok += outTok;
      s.costUSD += (inTok * p.in + outTok * p.out) / 1e6;
    }
  } catch (_) { /* non-JSON or missing metadata — skip accounting */ }

  res.writeHead(r.status, { ...CORS, "content-type": "application/json" });
  res.end(text);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`roody-proxy listening on :${PORT} — codes=${CODES.size} limit=${DAILY_LIMIT}/day key=${GEMINI_KEY ? "set" : "MISSING"}`);
});
