// Roody credits proxy v2 — Node.js for Hostinger's GitHub deploy.
// Zero dependencies: Node 18+ built-ins only (http + fs + global fetch).
//
// Env vars (hPanel → your Node.js app → Environment variables):
//   GEMINI_API_KEY  = AIza...   (founder's key — server-side only)
//   ADMIN_KEY       = long random string — unlocks /admin
//   ROODY_CODES     = optional comma-separated bootstrap codes
//   DAILY_LIMIT     = default messages/day for env + generated codes (50)
//   OPENAI_API_KEY  = optional — invite-code STT uses Whisper instead of Gemini
//   ANTHROPIC_API_KEY = optional — lets a code be minted with the Claude brain
//   XAI_API_KEY     = optional — lets a code be minted with the Grok brain
//   ELEVENLABS_API_KEY = optional — lets a code be minted with ElevenLabs voice
//   (a code's brain/voice silently falls back to Gemini if its key is absent)
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
const crypto = require("crypto"); // built-in — zero new deps

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// Optional: when set, invite-code STT is transcribed by OpenAI Whisper
// (better ears — accents, Telugu, noisy rooms) instead of Gemini. The key
// stays server-side; the extension never sees which engine transcribed.
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "nova"; // alloy, echo, fable, onyx, nova, shimmer
// Optional founder keys so a code can be minted to use Claude/Grok as its
// brain or ElevenLabs as its voice. All server-side; the extension never sees
// them. A code with no override stays on cheap Gemini.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const XAI_KEY = process.env.XAI_API_KEY || "";
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
// Which real model each brain choice maps to (the extension always asks for a
// Gemini model; the proxy swaps in the code's configured brain).
const BRAIN_MODEL = {
  gemini: "gemini-2.5-flash",
  claude: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  grok: process.env.GROK_MODEL || "grok-3-mini-fast",
};
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "50", 10);
const ENV_CODES = new Set(
  (process.env.ROODY_CODES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);

// Only the models Roody uses — nobody farms the key as a general endpoint.
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-preview-tts"]);

// Approximate pricing, $ per 1M tokens — for the admin cost column.
const PRICE = {
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-preview-tts": { in: 0.50, out: 10.00 },
  "claude-sonnet-4-6": { in: 3.00, out: 15.00 },
  "grok-3-mini-fast": { in: 0.30, out: 0.50 },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// ---- Dynamic codes (minted in the admin panel, persisted to disk) ----------
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, "roody-data.json");
let dyn = { codes: {} }; // { "ROODY-XXXX": { name, limit, disabled, created } }
try { dyn = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (_) {}
if (!dyn.users) dyn.users = {};       // { email: { name, invite_code, plan, joined_at, tokens:[{tok(sha256),exp}] } }
if (!dyn.waitlist) dyn.waitlist = []; // [{ email, name, source, created_at }]
function saveDyn() {
  try {
    // DATA_DIR may point to a folder that doesn't exist yet (fresh hPanel
    // setup) — create it instead of failing with ENOENT and silently losing
    // users/codes. Fix diagnosed by Antigravity on the live box.
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(dyn, null, 2));
  } catch (e) { console.error("save failed:", e.message); }
}
// Is the data file actually writable? Surfaced in /?health so a wrong
// DATA_DIR shows up as data_writable:false instead of silent data loss.
function dataWritable() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}
// A brain/voice is only honored if its founder key is actually configured —
// otherwise the code silently stays on Gemini so nothing breaks.
function resolveBrain(b) { return (b === "claude" && ANTHROPIC_KEY) || (b === "grok" && XAI_KEY) ? b : "gemini"; }
function resolveVoice(v) {
  if (v === "eleven" && ELEVEN_KEY) return "eleven";
  if (v === "openai" && OPENAI_KEY) return "openai";
  return "gemini";
}
function codeInfo(code) {
  if (dyn.codes[code]) {
    const c = dyn.codes[code];
    return c.disabled ? null : {
      name: c.name || "", limit: c.limit || DAILY_LIMIT, source: "panel",
      brain: resolveBrain(c.brain), voice: resolveVoice(c.voice),
    };
  }
  if (ENV_CODES.has(code)) return { name: "", limit: DAILY_LIMIT, source: "env", brain: "gemini", voice: "gemini" };
  return null;
}
function allCodes() {
  const list = [];
  for (const c of ENV_CODES) list.push({ code: c, name: "(env)", limit: DAILY_LIMIT, disabled: false, source: "env", brain: "gemini", voice: "gemini" });
  for (const [c, v] of Object.entries(dyn.codes)) {
    list.push({ code: c, name: v.name || "", limit: v.limit || DAILY_LIMIT, disabled: !!v.disabled, source: "panel",
      brain: resolveBrain(v.brain), voice: resolveVoice(v.voice), wantBrain: v.brain || "gemini", wantVoice: v.voice || "gemini" });
  }
  return list;
}
function mintCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return "ROODY-" + s;
}

// ---- User accounts & waitlist (zero-dependency, stored in roody-data.json) --
// Designed with Antigravity, hardened here: tokens are stored as sha256 HASHES
// (a leaked data file must not hand out live sessions), inputs are validated,
// and every list has a growth cap so a script can't bloat the JSON file.
const WAITLIST_CAP = 5000;
const ACCOUNTS_PER_CODE = 10;
const TOKENS_PER_USER = 5;
function validEmail(e) {
  return typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}
function makeToken() { return crypto.randomBytes(32).toString("hex"); }
function hashTok(t) { return crypto.createHash("sha256").update(t).digest("hex"); }
function tokenExpiry() { return Date.now() + 30 * 24 * 60 * 60 * 1000; } // 30 days
function userForToken(token) {
  if (!token) return null;
  const h = hashTok(token);
  for (const u of Object.values(dyn.users)) {
    const t = (u.tokens || []).find((t) => t.tok === h && t.exp > Date.now());
    if (t) return u;
  }
  return null;
}
function grantToken(user) {
  const token = makeToken();
  user.tokens = [...(user.tokens || []).filter((t) => t.exp > Date.now()), { tok: hashTok(token), exp: tokenExpiry() }]
    .slice(-TOKENS_PER_USER); // cap sessions per user
  return token;
}
function bearerToken(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
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

// ---- Provider translation ---------------------------------------------------
// The extension always speaks "Gemini". These helpers translate a Gemini-shaped
// request to Claude/Grok and translate the answer back, so the extension never
// knows which brain actually replied. Same trick as the Whisper STT path.
function geminiToMessages(body) {
  const system = (body.systemInstruction?.parts || []).map((p) => p.text).filter(Boolean).join("\n");
  const messages = (body.contents || []).map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: (c.parts || []).map((p) => p.text).filter(Boolean).join(""),
  })).filter((m) => m.content);
  const maxTokens = body.generationConfig?.maxOutputTokens || 400;
  const temperature = body.generationConfig?.temperature;
  return { system, messages, maxTokens, temperature };
}
function textToGemini(txt, inTok, outTok) {
  return {
    candidates: [{ content: { parts: [{ text: txt || "" }] } }],
    usageMetadata: { promptTokenCount: inTok || 0, candidatesTokenCount: outTok || 0 },
  };
}
async function callClaude(body) {
  const { system, messages, maxTokens, temperature } = geminiToMessages(body);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: BRAIN_MODEL.claude, max_tokens: maxTokens, ...(system ? { system } : {}), ...(temperature != null ? { temperature } : {}), messages }),
  });
  const j = await r.json();
  if (!r.ok) return { status: r.status, gemini: { error: j.error || j } };
  const txt = (j.content || []).map((b) => b.text).filter(Boolean).join("");
  return { status: 200, gemini: textToGemini(txt, j.usage?.input_tokens, j.usage?.output_tokens), model: BRAIN_MODEL.claude, inTok: j.usage?.input_tokens || 0, outTok: j.usage?.output_tokens || 0 };
}
async function callGrok(body) {
  const { system, messages, maxTokens, temperature } = geminiToMessages(body);
  const full = system ? [{ role: "system", content: system }, ...messages] : messages;
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${XAI_KEY}` },
    body: JSON.stringify({ model: BRAIN_MODEL.grok, max_tokens: maxTokens, ...(temperature != null ? { temperature } : {}), messages: full }),
  });
  const j = await r.json();
  if (!r.ok) return { status: r.status, gemini: { error: j.error || j } };
  const txt = j.choices?.[0]?.message?.content || "";
  return { status: 200, gemini: textToGemini(txt, j.usage?.prompt_tokens, j.usage?.completion_tokens), model: BRAIN_MODEL.grok, inTok: j.usage?.prompt_tokens || 0, outTok: j.usage?.completion_tokens || 0 };
}
// ElevenLabs voice: pull the text out of the Gemini TTS body, synthesize, and
// return the MP3 as base64 in Gemini's inlineData shape.
async function callElevenTTS(body) {
  const txt = (body.contents?.[0]?.parts || []).map((p) => p.text).filter(Boolean).join("").slice(0, 1200);
  if (!txt) return { status: 400, gemini: { error: "no-text" } };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: txt, model_id: "eleven_flash_v2_5" }),
  });
  if (!r.ok) return { status: r.status, gemini: { error: (await r.text()).slice(0, 200) }, chars: txt.length };
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    status: 200, chars: txt.length,
    gemini: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: buf.toString("base64") } }] } }] },
  };
}
// OpenAI TTS: same translation trick — Gemini-shaped request in, MP3 base64 out.
// Used as a per-code voice option AND as the automatic failover when Gemini TTS
// hits its 100 req/day cap on the paid tier (returns 429).
async function callOpenAITTS(body) {
  const txt = (body.contents?.[0]?.parts || []).map((p) => p.text).filter(Boolean).join("").slice(0, 4096);
  if (!txt) return { status: 400, gemini: { error: "no-text" } };
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE, input: txt, response_format: "mp3" }),
  });
  if (!r.ok) return { status: r.status, gemini: { error: (await r.text()).slice(0, 200) }, chars: txt.length };
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    status: 200, chars: txt.length,
    gemini: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: buf.toString("base64") } }] } }] },
  };
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
    const brainLbl = { gemini: "Gemini", claude: "Claude", grok: "Grok" }[c.brain] || "Gemini";
    const voiceLbl = c.voice === "eleven" ? "11Labs" : c.voice === "openai" ? "OpenAI" : "Gemini";
    const warn = (c.wantBrain && c.wantBrain !== c.brain) || (c.wantVoice && c.wantVoice !== c.voice) ? " ⚠️" : "";
    return `<tr${c.disabled ? ' style="opacity:.45"' : ""}>
      <td><b>${esc(c.code)}</b>${c.disabled ? " 🚫" : ""}</td>
      <td>${esc(c.name)}</td>
      <td>${brainLbl} · ${voiceLbl}${warn}</td>
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
input,select{background:#1c1712;border:1px solid #3a3025;color:#f0e6da;border-radius:8px;padding:8px 10px;font-size:14px}
button{background:#e98a3c;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
.msg{color:#7ec97e;font-weight:600;margin-bottom:10px}</style>
<meta http-equiv="refresh" content="60"></head><body>
<h1>🟠 Roody Admin</h1>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<div class="k">Messages today: <b>${totalToday}</b></div>
<div class="k">Total est. spend: <b>$${totalCost.toFixed(4)} · ₹${(totalCost * 85).toFixed(2)}</b></div>
<div class="k">Codes: <b>${allCodes().length}</b></div>
<div class="k"><a href="/admin/test-keys?key=${k}" style="color:#e98a3c;text-decoration:none">🔑 Test keys</a></div>
<form action="/admin/new" method="get">
  <input type="hidden" name="key" value="${esc(ADMIN_KEY)}">
  <b>🎟 New code:</b>
  <input name="name" placeholder="who is it for? (e.g. Priya)" required>
  <input name="limit" type="number" value="${DAILY_LIMIT}" min="1" max="1000" style="width:80px" title="messages/day">
  <select name="brain" title="brain — Claude/Grok only work if that founder key is set in hPanel">
    <option value="gemini">🧠 Gemini (cheap)</option>
    <option value="claude"${ANTHROPIC_KEY ? "" : " disabled"}>🧠 Claude${ANTHROPIC_KEY ? "" : " (no key)"}</option>
    <option value="grok"${XAI_KEY ? "" : " disabled"}>🧠 Grok${XAI_KEY ? "" : " (no key)"}</option>
  </select>
  <select name="voice" title="voice — ElevenLabs/OpenAI only work if that founder key is set in hPanel">
    <option value="gemini">🗣 Gemini voice (auto-failover to OpenAI if capped)</option>
    <option value="openai"${OPENAI_KEY ? "" : " disabled"}>🗣 OpenAI TTS (nova)${OPENAI_KEY ? "" : " (no key)"}</option>
    <option value="eleven"${ELEVEN_KEY ? "" : " disabled"}>🗣 ElevenLabs${ELEVEN_KEY ? "" : " (no key)"}</option>
  </select>
  <button>Generate</button>
</form>
<table><tr><th>Code</th><th>Name</th><th>Brain · Voice</th><th>Today</th><th>TTS · STT</th><th>All-time</th><th>Est. cost</th><th>Last used</th><th></th></tr>${rows}</table>

<h2 style="margin-top:28px;color:#cbb59c;font-size:17px">👥 Users (${Object.keys(dyn.users || {}).length})</h2>
<table><tr><th>Email</th><th>Name</th><th>Code</th><th>Plan</th><th>Joined</th></tr>
${Object.values(dyn.users || {}).slice(-50).map((v) =>
    `<tr><td>${esc(v.email)}</td><td>${esc(v.name || "—")}</td><td>${esc(v.invite_code)}</td><td>${esc(v.plan || "free")}</td><td>${new Date(v.joined_at).toLocaleString()}</td></tr>`
  ).join("") || '<tr><td colspan="5" style="color:#a89880">No users yet</td></tr>'}</table>

<h2 style="margin-top:28px;color:#cbb59c;font-size:17px">📬 Waitlist (${(dyn.waitlist || []).length})</h2>
<table><tr><th>Email</th><th>Name</th><th>Source</th><th>Joined</th></tr>
${(dyn.waitlist || []).slice(-50).reverse().map((w) =>
    `<tr><td>${esc(w.email)}</td><td>${esc(w.name || "—")}</td><td>${esc(w.source || "—")}</td><td>${new Date(w.created_at).toLocaleString()}</td></tr>`
  ).join("") || '<tr><td colspan="4" style="color:#a89880">Empty</td></tr>'}</table>

<p style="color:#a89880;font-size:12px;margin-top:16px">Metadata only — conversations are never stored. Panel-minted codes, users and the waitlist persist to roody-data.json (survives restarts; a full redeploy may reset them — set DATA_DIR in hPanel to a persistent folder, and keep VIP codes in the ROODY_CODES env var too). Auto-refreshes every 60s.</p>
</body></html>`;
}

// ---- Server -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }

  if (req.method === "GET") {
    const u = new URL(req.url, "http://x");

    // User portal page (same serve-from-site pattern as /privacy and /roody).
    if (u.pathname === "/portal" || u.pathname === "/portal.html") {
      try {
        const html = fs.readFileSync(path.join(__dirname, "..", "site", "portal.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (_) {
        return json(res, 404, { error: "portal-not-found" });
      }
    }

    // Profile + usage for logged-in portal users. Separate path from the
    // extension's /me?code= endpoint, which must never change shape.
    if (u.pathname === "/me/profile") {
      const user = userForToken(bearerToken(req));
      if (!user) return json(res, 401, { error: "not-logged-in" });
      const s = statFor(user.invite_code);
      const info = codeInfo(user.invite_code);
      return json(res, 200, {
        ok: true,
        user: {
          email: user.email, name: user.name || null, plan: user.plan || "free",
          invite_code: user.invite_code, joined_at: user.joined_at,
        },
        usage: {
          today: {
            brain_calls: s.todayBrain, tts_calls: s.todayTts, stt_calls: s.todayStt,
            daily_limit: info?.limit || DAILY_LIMIT,
            remaining: Math.max(0, (info?.limit || DAILY_LIMIT) - s.todayBrain),
          },
          allTime: {
            brain_calls: s.allBrain, in_tokens: s.inTok, out_tokens: s.outTok,
            cost_usd: s.costUSD.toFixed(4),
          },
        },
      });
    }

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
        const brain = ["gemini", "claude", "grok"].includes(u.searchParams.get("brain")) ? u.searchParams.get("brain") : "gemini";
        const voice = ["gemini", "eleven", "openai"].includes(u.searchParams.get("voice")) ? u.searchParams.get("voice") : "gemini";
        dyn.codes[code] = {
          name: (u.searchParams.get("name") || "").slice(0, 60),
          limit: Math.max(1, Math.min(1000, parseInt(u.searchParams.get("limit") || DAILY_LIMIT, 10) || DAILY_LIMIT)),
          brain, voice,
          disabled: false,
          created: Date.now(),
        };
        saveDyn();
        const note = (brain === "claude" || brain === "grok" || voice === "eleven") ? ` — ${brain}/${voice}` : "";
        return back(`Created ${code} for ${dyn.codes[code].name || "—"}${note}`);
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
      // Key health test — runs a minimal live request against each configured API.
      if (u.pathname === "/admin/test-keys") {
        const results = [];
        const check = async (label, fn) => { try { results.push([label, await fn()]); } catch (e) { results.push([label, `❌ ${e.message}`]); } };
        await check("Gemini brain", async () => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 3 } }),
          });
          return r.ok ? "✅ OK" : `⚠️ HTTP ${r.status}`;
        });
        await check("Gemini TTS", async () => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_KEY}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
          });
          if (r.ok) return "✅ OK";
          if (r.status === 429) return `⚠️ 429 — daily cap hit · OpenAI TTS backup ${OPENAI_KEY ? "active" : "NO KEY"}`;
          return `⚠️ HTTP ${r.status}`;
        });
        if (OPENAI_KEY) {
          await check("OpenAI STT (Whisper)", async () => {
            const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${OPENAI_KEY}` } });
            return r.ok ? "✅ OK" : `⚠️ HTTP ${r.status}`;
          });
          await check("OpenAI TTS", async () => {
            const r = await fetch("https://api.openai.com/v1/audio/speech", {
              method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
              body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE, input: "hi", response_format: "mp3" }),
            });
            return r.ok ? `✅ OK (${OPENAI_TTS_VOICE})` : `⚠️ HTTP ${r.status}`;
          });
        } else { results.push(["OpenAI STT + TTS", "❌ no OPENAI_API_KEY in hPanel"]); }
        if (ANTHROPIC_KEY) {
          await check("Claude brain", async () => {
            const r = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST", headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: BRAIN_MODEL.claude, max_tokens: 3, messages: [{ role: "user", content: "hi" }] }),
            });
            return r.ok ? `✅ OK (${BRAIN_MODEL.claude})` : `⚠️ HTTP ${r.status}`;
          });
        } else { results.push(["Claude brain", "❌ no ANTHROPIC_API_KEY"]); }
        if (XAI_KEY) {
          await check("Grok brain", async () => {
            const r = await fetch("https://api.x.ai/v1/chat/completions", {
              method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${XAI_KEY}` },
              body: JSON.stringify({ model: BRAIN_MODEL.grok, max_tokens: 3, messages: [{ role: "user", content: "hi" }] }),
            });
            return r.ok ? `✅ OK (${BRAIN_MODEL.grok})` : `⚠️ HTTP ${r.status}`;
          });
        } else { results.push(["Grok brain", "❌ no XAI_API_KEY"]); }
        if (ELEVEN_KEY) {
          await check("ElevenLabs TTS", async () => {
            const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } });
            return r.ok ? "✅ OK" : `⚠️ HTTP ${r.status}`;
          });
        } else { results.push(["ElevenLabs TTS", "❌ no ELEVENLABS_API_KEY"]); }
        const rows = results.map(([k, v]) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #3a3025"><b>${esc(k)}</b></td><td style="padding:10px 14px;border-bottom:1px solid #3a3025">${esc(v)}</td></tr>`).join("");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Key Test — Roody</title>
<style>body{font-family:system-ui,sans-serif;background:#1c1712;color:#f0e6da;padding:32px;max-width:640px;margin:0 auto}h1{color:#e98a3c}a{color:#e98a3c}table{width:100%;border-collapse:collapse;font-size:15px}</style>
</head><body><h1>🔑 Key Health Check</h1>
<p style="color:#a89880;margin-bottom:20px">Live test · ${new Date().toLocaleString()}</p>
<table>${rows}</table>
<p style="margin-top:24px"><a href="/admin?key=${k}">← Back to admin</a></p>
</body></html>`);
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
      whisper: !!OPENAI_KEY,
      brains: { gemini: !!GEMINI_KEY, claude: !!ANTHROPIC_KEY, grok: !!XAI_KEY },
      voices: { gemini: !!GEMINI_KEY, eleven: !!ELEVEN_KEY },
      data_file: DATA_FILE,
      data_writable: dataWritable(),
      users: Object.keys(dyn.users || {}).length,
      waitlist: (dyn.waitlist || []).length,
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "method" });

  // ---- Accounts & waitlist (POST) — each route returns; anything else falls
  // through to the AI proxy below, untouched. ---------------------------------
  const pu = new URL(req.url, "http://x");

  if (pu.pathname === "/auth/register") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad-json" }); }
    const em = (b?.email || "").trim().toLowerCase();
    const code = (b?.invite_code || "").trim().toUpperCase();
    if (!validEmail(em)) return json(res, 400, { error: "valid email required" });
    if (!code) return json(res, 400, { error: "invite_code required" });
    if (!codeInfo(code)) return json(res, 403, { error: "invalid-invite-code" });
    if (dyn.users[em]) return json(res, 409, { error: "email already registered — sign in instead" });
    // One leaked code must not mint unlimited accounts.
    const onCode = Object.values(dyn.users).filter((x) => x.invite_code === code).length;
    if (onCode >= ACCOUNTS_PER_CODE) return json(res, 403, { error: "code-account-limit" });
    dyn.users[em] = {
      email: em, name: (b?.name || "").slice(0, 60) || null, invite_code: code,
      plan: "free", joined_at: Date.now(), source: (b?.source || "").slice(0, 40) || null,
      tokens: [],
    };
    const token = grantToken(dyn.users[em]);
    saveDyn();
    return json(res, 200, { ok: true, token, user: { email: em, name: dyn.users[em].name, plan: "free", invite_code: code } });
  }

  if (pu.pathname === "/auth/login") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad-json" }); }
    const em = (b?.email || "").trim().toLowerCase();
    const code = (b?.invite_code || "").trim().toUpperCase();
    if (!em || !code) return json(res, 400, { error: "email and invite_code required" });
    const user = dyn.users[em];
    if (!user || user.invite_code !== code) return json(res, 401, { error: "email or invite code doesn't match" });
    const token = grantToken(user);
    saveDyn();
    return json(res, 200, { ok: true, token, user: { email: em, name: user.name, plan: user.plan, invite_code: code } });
  }

  if (pu.pathname === "/auth/logout") {
    const raw = bearerToken(req);
    const user = userForToken(raw);
    if (user) {
      const h = hashTok(raw);
      user.tokens = (user.tokens || []).filter((t) => t.tok !== h);
      saveDyn();
    }
    return json(res, 200, { ok: true });
  }

  if (pu.pathname === "/auth/update") {
    const user = userForToken(bearerToken(req));
    if (!user) return json(res, 401, { error: "not-logged-in" });
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad-json" }); }
    if (b?.name) { user.name = String(b.name).slice(0, 60); saveDyn(); }
    return json(res, 200, { ok: true, name: user.name });
  }

  if (pu.pathname === "/waitlist") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad-json" }); }
    const em = (b?.email || "").trim().toLowerCase();
    if (!validEmail(em)) return json(res, 400, { error: "valid email required" });
    if (dyn.waitlist.length >= WAITLIST_CAP) return json(res, 503, { error: "waitlist-full" });
    if (!dyn.waitlist.find((w) => w.email === em)) {
      dyn.waitlist.push({ email: em, name: (b?.name || "").slice(0, 60) || null, source: (b?.source || "").slice(0, 40) || null, created_at: Date.now() });
      saveDyn();
    }
    return json(res, 200, { ok: true, message: "You're on the list! 🐶" });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "bad-json" });
  }
  const code = (payload.code || "").trim().toUpperCase();
  const { kind, model, body } = payload;

  if (!code || !model || !body) return json(res, 400, { error: "missing-fields" });
  // Strict kind whitelist — an unknown kind used to skip ALL counting while
  // still forwarding to Gemini, letting any code holder drain the key.
  if (!["brain", "tts", "stt"].includes(kind)) return json(res, 400, { error: "bad-kind" });
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

  // STT via Whisper when an OpenAI key is configured. The extension sends the
  // Gemini STT shape (audio as an inlineData part); we translate: pull the
  // audio out, send it to OpenAI's transcription API, and wrap the transcript
  // back in a Gemini-shaped response so the extension can't tell the
  // difference. Falls through to Gemini if anything's off.
  if (kind === "stt" && OPENAI_KEY) {
    const part = (body.contents?.[0]?.parts || []).find((p) => p.inlineData);
    if (part?.inlineData?.data) {
      try {
        const bytes = Buffer.from(part.inlineData.data, "base64");
        const fd = new FormData();
        fd.append("model", OPENAI_STT_MODEL);
        fd.append(
          "file",
          new Blob([bytes], { type: part.inlineData.mimeType || "audio/wav" }),
          /webm/i.test(part.inlineData.mimeType || "") ? "audio.webm" : "audio.wav"
        );
        const w = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: `Bearer ${OPENAI_KEY}` },
          body: fd,
        });
        if (w.ok) {
          const out = await w.json();
          // Whisper bills per minute — read the duration from the WAV header
          // (sample rate at byte 24, data size at 40) for the cost column.
          try {
            if (bytes.length > 44 && bytes.toString("ascii", 0, 4) === "RIFF") {
              const rate = bytes.readUInt32LE(24);
              const dataSize = bytes.readUInt32LE(40);
              if (rate > 0) s.costUSD += (dataSize / (rate * 2) / 60) * 0.003;
            }
          } catch (_) {}
          return json(res, 200, {
            candidates: [{ content: { parts: [{ text: out.text || "" }] } }],
          });
        }
        console.error(`whisper ${w.status}: ${(await w.text()).slice(0, 200)} — falling back to Gemini STT`);
      } catch (e) {
        console.error(`whisper unreachable (${e.message}) — falling back to Gemini STT`);
      }
    }
  }

  // Brain via Claude/Grok when the code is configured for it (and the founder
  // key exists). Translate in and out so the extension stays Gemini-shaped.
  if (kind === "brain" && info.brain !== "gemini") {
    try {
      const out = info.brain === "claude" ? await callClaude(body) : await callGrok(body);
      if (out.status === 200) {
        const p = PRICE[out.model] || { in: 0, out: 0 };
        s.inTok += out.inTok; s.outTok += out.outTok;
        s.costUSD += (out.inTok * p.in + out.outTok * p.out) / 1e6;
      }
      return json(res, out.status, out.gemini);
    } catch (e) {
      console.error(`${info.brain} unreachable (${e.message}) — falling back to Gemini`);
    }
  }
  // Voice via OpenAI TTS when the code is configured for it.
  if (kind === "tts" && info.voice === "openai") {
    try {
      const out = await callOpenAITTS(body);
      if (out.status === 200) s.costUSD += ((out.chars || 0) / 1000) * 0.015; // ~$0.015/1k chars
      if (out.status === 200 || out.status === 400) return json(res, out.status, out.gemini);
      console.error(`openai tts ${out.status} — falling back to Gemini TTS`);
    } catch (e) {
      console.error(`openai tts unreachable (${e.message}) — falling back to Gemini TTS`);
    }
  }
  // Voice via ElevenLabs when the code is configured for it.
  if (kind === "tts" && info.voice === "eleven") {
    try {
      const out = await callElevenTTS(body);
      if (out.status === 200) s.costUSD += ((out.chars || 0) / 1000) * 0.10; // ~$0.10/1k chars
      if (out.status === 200 || out.status === 400) return json(res, out.status, out.gemini);
      console.error(`elevenlabs ${out.status} — falling back to Gemini TTS`);
    } catch (e) {
      console.error(`elevenlabs unreachable (${e.message}) — falling back to Gemini TTS`);
    }
  }

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

  // Gemini TTS failover — if the TTS model is capped (429) or flaking (5xx),
  // silently re-synthesize with OpenAI so the user hears a voice instead of
  // silence. Works for ALL codes regardless of voice setting.
  if (kind === "tts" && (r.status === 429 || r.status >= 500) && OPENAI_KEY) {
    console.error(`gemini tts ${r.status} — failing over to OpenAI TTS`);
    try {
      const out = await callOpenAITTS(body);
      if (out.status === 200) {
        s.costUSD += ((out.chars || 0) / 1000) * 0.015;
        return json(res, 200, out.gemini);
      }
      console.error(`openai tts failover ${out.status} — returning original gemini error`);
    } catch (e) {
      console.error(`openai tts failover unreachable (${e.message})`);
    }
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
  console.log(`roody-proxy v2 on :${PORT} — env codes=${ENV_CODES.size} panel codes=${Object.keys(dyn.codes).length} key=${GEMINI_KEY ? "set" : "MISSING"} admin=${ADMIN_KEY ? "set" : "MISSING"} data=${DATA_FILE} writable=${dataWritable()}`);
});
