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

// code -> { day: "2026-07-03", count: n }
const usage = new Map();
const today = () => new Date().toISOString().slice(0, 10);

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

  // Brain calls burn a credit; tts/stt ride along on a valid code.
  if (kind === "brain") {
    const u = usage.get(code);
    const rec = u && u.day === today() ? u : { day: today(), count: 0 };
    if (rec.count >= DAILY_LIMIT) {
      return json(res, 402, { error: "out-of-credits", used: rec.count, limit: DAILY_LIMIT });
    }
    rec.count += 1;
    usage.set(code, rec);
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
  res.writeHead(r.status, { ...CORS, "content-type": "application/json" });
  res.end(text);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`roody-proxy listening on :${PORT} — codes=${CODES.size} limit=${DAILY_LIMIT}/day key=${GEMINI_KEY ? "set" : "MISSING"}`);
});
