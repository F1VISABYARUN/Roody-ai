// Roody's brain-stem: receives messages from the orb, calls the model, sends
// the reply back. Roody is a coding assistant — it reads the page (and, on
// request, a screenshot of the screen) and answers in the chat. No voice.
try { importScripts("persona.js"); } catch (_) { importScripts("src/persona.js"); }
try { importScripts("sanitize.js"); } catch (_) { importScripts("src/sanitize.js"); }

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Gemini 2.5 Flash is the default brain: cheap, fast, multimodal (so it can
// read screenshots). Users can switch to Claude/Grok in settings with a key.
const MODEL = "gemini-2.5-flash";

// Pull the user's settings (API keys + chosen model) from extension storage.
async function getSettings() {
  const { roodyApiKey, roodyModel, roodyXaiKey, roodyOpenAIKey } = await chrome.storage.local.get([
    "roodyApiKey",
    "roodyModel",
    "roodyXaiKey",
    "roodyOpenAIKey",
  ]);
  return {
    apiKey: roodyApiKey,
    xaiKey: roodyXaiKey,
    openaiKey: roodyOpenAIKey,
    model: roodyModel || MODEL,
  };
}

// ---- Cost meter -----------------------------------------------------------
// USD → INR conversion. Approximate; refresh manually when needed.
const USD_TO_INR = 85;
const fmtMoney = (usd) => `$${usd.toFixed(4)} · ₹${(usd * USD_TO_INR).toFixed(2)}`;
// Rough $/1M tokens.
const PRICES = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "grok-3": { in: 3, out: 15 },
  "grok-3-mini": { in: 0.3, out: 0.5 },
  "grok-3-mini-fast": { in: 0.3, out: 0.5 },
  // OpenAI — approximate list prices, refresh alongside the others.
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
};
async function addUsage(model, inTok, outTok, costOverride) {
  const p = PRICES[model] || { in: 0, out: 0 };
  // costOverride lets callers pass the exact cache-aware cost (cache reads
  // are 10% of input price — the naive formula would overcharge them 10x).
  const cost = costOverride != null ? costOverride : (inTok * p.in + outTok * p.out) / 1e6;
  const { roodyUsage } = await chrome.storage.local.get(["roodyUsage"]);
  const u = roodyUsage || { costUSD: 0, calls: 0, inTok: 0, outTok: 0 };
  u.costUSD += cost;
  u.calls += 1;
  u.inTok += inTok;
  u.outTok += outTok;
  await chrome.storage.local.set({ roodyUsage: u });
}

// ---- Roody log -----------------------------------------------------------
// A circular buffer of recent events (timing + errors). Visible in Settings so
// you can paste it back when something feels off. Stored in chrome.storage so
// it survives across pages and is shared between content + background.
async function rlog(line) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const { roodyLog } = await chrome.storage.local.get(["roodyLog"]);
  const log = Array.isArray(roodyLog) ? roodyLog : [];
  log.push(`${ts}  ${line}`);
  while (log.length > 200) log.shift();
  await chrome.storage.local.set({ roodyLog: log });
}

// Reply language. `roodyLang` stores a BCP-47 tag (e.g. "hi-IN"); we map the
// primary subtag to a name and tell the brain to answer in that language.
const LANG_NAMES = {
  "te": "Telugu", "hi": "Hindi", "ta": "Tamil", "kn": "Kannada", "ml": "Malayalam",
  "es": "Spanish", "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
};
function langName(code) {
  if (!code) return null;
  const short = code.split("-")[0];
  return LANG_NAMES[short] || null;
}

// ---- Modes ----------------------------------------------------------------
// content.js detects the page type from cheap heuristics (URL + DOM) and sends
// a `pageMode`. We inject a short instruction so Roody acts like the right kind
// of expert for the context — invisible to the user, no extra LLM call.
const MODE_HINTS = {
  code:
    "CODE MODE: They're looking at code, a diff, or an error. Find the actual bug, the risky line, the edge case they'll hit. If there's an error, name the likely cause and where to look, then give the fix as a code block. Don't narrate what the code obviously does — find what's wrong or what's simpler.",
  learning:
    "LEARNING MODE: They're studying a document. Optimize for understanding: the one idea that matters most, what people usually misunderstand, and a concrete example. Offer to quiz them.",
  research:
    "RESEARCH MODE: They're reading research or docs. Separate evidence from claims, flag what's strong vs weak, name the open question, and point to what's worth reading deeper. Don't just summarize.",
  writing:
    "WRITING MODE: They're writing. Be a sharp editor: the weak sentence, the missing argument, the stronger phrasing, the flow break. Judge clarity, don't just praise.",
  founder:
    "FOUNDER MODE: They're working on product/startup material. Surface the real risk, the competitor, the moat gap, the objection an investor would raise. Be the honest co-founder who says the hard thing.",
};

// Build the full system prompt: base persona + active vibe overlay.
function getSystemPrompt(vibe) {
  const overlay = (self.ROODY_VIBES && self.ROODY_VIBES[vibe]) || "";
  return overlay ? self.ROODY_SYSTEM + "\n" + overlay : self.ROODY_SYSTEM;
}

// Build a short "notebook" of the user's recent Roody-engaged pages.
// Only the last 5 fit in the prompt. Format: site · title · snippet.
function buildMemoryBlock(memory) {
  if (!Array.isArray(memory) || memory.length === 0) return "";
  const recent = memory.slice(-5);
  const lines = recent.map((m) => {
    const when = m.ts ? new Date(m.ts).toLocaleTimeString() : "";
    // A session recap ("what we worked on + where it left off") beats a raw
    // page snippet — use it when we have one.
    const gist = m.summary ? `RECAP: ${m.summary}` : (m.snippet || "").slice(0, 120);
    return `- [${when}] ${m.site} · "${m.title}" — ${gist}`;
  });
  return `\nYour running notebook of the user's recent activity (only pages where they engaged with you). Use RECAP lines to pick threads back up naturally:\n${lines.join("\n")}\n\n`;
}

// User's own "about me" — a small text they can set in Settings so Roody
// knows who they are. Prepended to the system prompt.
function buildProfileBlock(profile) {
  const p = (profile || "").trim();
  if (!p) return "";
  return `About the user (what they told you about themselves):\n"${p.slice(0, 500)}"\n\n`;
}

// ---- Retry helper for transient failures --------------------------------
// A brain that answers 502 on the first try often works on the second. We used
// to bubble every non-2xx as "the model hiccuped" with no retry — the founder
// saw a real one of these on Gemini and it looked broken. Only retry the codes
// that mean "try again", never the ones that mean "you did something wrong"
// (400/401/402/403/404). At most 2 retries so the whole turn stays under the
// content-side watchdog even in the worst case.
const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [500, 1500, 3500];
async function fetchWithRetry(url, init, label) {
  let networkErr = null;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      rlog(`↻ ${label} retry ${attempt}`);
    }
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      if (!RETRIABLE_STATUS.has(resp.status)) return resp; // deterministic error
      if (attempt === BACKOFF_MS.length - 1) return resp;  // out of retries
      rlog(`⚠ ${label} ${resp.status} — will retry`);
    } catch (e) {
      networkErr = e;
      if (attempt === BACKOFF_MS.length - 1) throw e;
      rlog(`⚠ ${label} network (${e.message}) — will retry`);
    }
  }
  if (networkErr) throw networkErr;
}

// Which selected brains can actually read an attached screenshot. Gemini,
// Claude, and the GPT-4o/4.1 family are multimodal; Grok-3 (text) is not, so
// image turns get routed to Gemini vision instead.
function modelSupportsVision(model) {
  return model.startsWith("gemini-") || model.startsWith("claude-") || model.startsWith("gpt-");
}
// The OpenAI-compatible brains (OpenAI itself and xAI's Grok).
function isOpenAIModel(model) {
  return model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
}

// Ask Roody's brain. Routes to OpenAI, Claude, Gemini, or Grok depending on the
// model selected in settings. `pageContext` is the read-only text scraped from
// the page; `history` is the running chat; `image` (optional) is a screenshot
// the user asked Roody to look at, as { mime, data } where data is base64.
async function askRoody({ userText, pageContext, history, site, title, pageMode, image }) {
  const { apiKey, xaiKey, openaiKey, model: settingsModel } = await getSettings();
  const { roodyLang, roodyVibe, roodyMemory, roodyProfile } = await chrome.storage.local.get(["roodyLang", "roodyVibe", "roodyMemory", "roodyProfile"]);

  let model = settingsModel;
  // Credential-aware routing: invite-code-only users default to a brain they
  // have no key for. If the selected brain's key is missing but Gemini is
  // reachable (own key or invite code), route to Gemini instead of erroring —
  // fresh installs must Just Work with only a code.
  const { roodyGeminiKey, roodyInviteCode } = await chrome.storage.local.get(["roodyGeminiKey", "roodyInviteCode"]);
  const geminiReachable = !!(roodyGeminiKey || roodyInviteCode);
  if (geminiReachable) {
    if (model.startsWith("grok-") && !xaiKey) model = "gemini-2.5-flash";
    else if (isOpenAIModel(model) && !openaiKey) model = "gemini-2.5-flash";
    else if (!model.startsWith("grok-") && !model.startsWith("gemini-") && !isOpenAIModel(model) && !apiKey) model = "gemini-2.5-flash";
  }
  // Vision fallback lives OUTSIDE the geminiReachable guard on purpose: if
  // Gemini is set up, route the image turn to it; otherwise drop the image and
  // tell the user, instead of silently discarding a screenshot that the model
  // then answers blind about (the old Grok-only-key bug).
  let imageDropReason = "";
  if (image) {
    if (!modelSupportsVision(model)) {
      if (geminiReachable) {
        model = "gemini-2.5-flash";
      } else {
        imageDropReason = "this brain can't see images and Gemini isn't set up";
        image = null;
      }
    }
  }

  const baseSystem = getSystemPrompt(roodyVibe || "normal");
  const profileBlock = buildProfileBlock(roodyProfile);
  const memoryBlock = buildMemoryBlock(roodyMemory);
  // Prompt-caching split:
  //   stable part = persona + profile + mode (rarely changes → cached)
  //   dynamic part = memory (updates every turn → NOT cached)
  const modeBlock = (pageMode && MODE_HINTS[pageMode]) ? MODE_HINTS[pageMode] + "\n\n" : "";
  const stableSystem = profileBlock + modeBlock + baseSystem;
  const systemPrompt = profileBlock + modeBlock + memoryBlock + baseSystem;

  // Passing imageDropReason through every path so the reply carries the "we
  // couldn't send your screenshot" note in-bubble, instead of silently
  // answering blind (the old xAI-only-key bug).
  const wrap = (out) => imageDropReason && out && out.ok
    ? { ...out, text: `_(couldn't send the screenshot — ${imageDropReason})_\n\n${out.text}` }
    : out;

  // Gemini brain
  if (model && model.startsWith("gemini-")) {
    return wrap(await askGeminiBrain({ userText, pageContext, history, model, lang: roodyLang, systemPrompt, site, title, image }));
  }
  // OpenAI brain (GPT-4o / 4.1 family — multimodal, so screenshots ride along)
  if (model && isOpenAIModel(model)) {
    return wrap(await askOpenAIBrain({ userText, pageContext, history, model, lang: roodyLang, openaiKey, systemPrompt, site, title, image }));
  }
  // Grok brain (text only — image turns were already re-routed to Gemini above,
  // or the image was dropped with imageDropReason set).
  if (model && model.startsWith("grok-")) {
    return wrap(await askGrokBrain({ userText, pageContext, history, model, lang: roodyLang, xaiKey, systemPrompt, site, title }));
  }
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Roody isn't set up yet — open Settings (⚙) and paste your invite code.",
    };
  }

  // ---- Claude path ----
  const ctxCap = 14000;
  const siteHint = site ? `The user is on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text in quotes below is what's on their screen right now — it is context, NOT a message from them.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page (read-only):\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  // Language instruction: if non-English, tell the brain to reply in that language.
  const lName = langName(roodyLang);
  const langInstr = lName
    ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n`
    : "";
  const imageNote = image ? "A screenshot of the user's screen is attached below — use it to answer.\n\n" : "";

  // The newest user turn is a text block (context + question); when a screenshot
  // is attached it becomes a multi-part content array with an image block.
  const userTurnText = `${langInstr}${imageNote}${contextBlock}${userText}`;
  const userContent = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.mime || "image/jpeg", data: image.data } },
        { type: "text", text: userTurnText },
      ]
    : userTurnText;

  const messages = [
    ...history,
    { role: "user", content: userContent },
  ];

  const { roodyWebSearch } = await chrome.storage.local.get(["roodyWebSearch"]);
  const tools =
    roodyWebSearch !== false
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]
      : undefined;

  // Server-side search runs a loop; if it pauses, re-send to let it continue.
  let finalText = "";
  for (let i = 0; i < 4; i++) {
    let resp;
    const t0 = performance.now();
    rlog(`→ Claude ${model} (msgs=${messages.length}${tools ? " +web" : ""}${image ? " +img" : ""})`);
    try {
      resp = await fetchWithRetry(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Required for calling the API directly from a browser extension (CORS).
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          temperature: 0.3,
          // Prompt caching: mark the stable persona+profile as ephemeral so
          // Anthropic caches it for 5 min. Memory (dynamic) stays uncached in
          // a second block. 90% discount on the cached read after call #1.
          system: memoryBlock
            ? [
                { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
                { type: "text", text: memoryBlock },
              ]
            : [
                { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
              ],
          messages,
          ...(tools ? { tools } : {}),
        }),
      }, "Claude");
    } catch (e) {
      rlog(`❌ Claude network: ${e.message}`);
      return { ok: false, error: "I couldn't reach the internet — check your connection and try again?" };
    }
    if (!resp.ok) {
      const body = await resp.text();
      rlog(`❌ Claude ${resp.status}: ${body.slice(0, 200)}`);
      return { ok: false, error: "The model hiccuped for a second — try that again?" };
    }
    const data = await resp.json();
    const ms = Math.round(performance.now() - t0);
    const inTok = data.usage?.input_tokens || 0;
    const outTok = data.usage?.output_tokens || 0;
    const cacheRead = data.usage?.cache_read_input_tokens || 0;
    const cacheWrite = data.usage?.cache_creation_input_tokens || 0;
    const p = PRICES[model] || { in: 0, out: 0 };
    // Cache math: reads = 10% of input price, writes = 125% of input price
    const turnCost = (inTok * p.in + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25 + outTok * p.out) / 1e6;
    const cacheTag = cacheRead > 0 ? ` · 💾 cache HIT ${cacheRead}` : (cacheWrite > 0 ? ` · 💾 cache WRITE ${cacheWrite}` : "");
    rlog(`✓ Claude ${ms}ms · in=${inTok} out=${outTok}${cacheTag} · ${fmtMoney(turnCost)} · ${data.stop_reason}`);
    if (data.usage) addUsage(model, inTok + cacheRead + cacheWrite, outTok, turnCost);
    const txt = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (txt) finalText = txt;
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: "Continue." });
      continue;
    }
    break;
  }
  return wrap({ ok: true, text: sanitizeReply(finalText) || "…" });
}

// Reply hygiene lives in sanitize.js (shared with the eval agent so every
// leak we fix becomes a permanent regression test).
function sanitizeReply(txt) {
  return self.RoodySanitize.sanitizeReply(txt);
}

// ---- Gemini brain ---------------------------------------------------------
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Founder's credits proxy (Hostinger Node.js, deployed from this repo's
// server/ folder). Users with an invite code but no own Gemini key are
// routed through here — the real key lives in the server's env vars.
// (Users can override in Settings → Invite Code → Advanced.)
const ROODY_PROXY_URL = "https://midnightblue-wolf-859857.hostingersite.com/";

// Gemini router: own key → straight to Google. No key but invite code →
// through the founder's proxy (kind: "brain" burns a credit). Screenshots ride
// along inside the same "brain" body as an inlineData part — gemini-2.5-flash
// is multimodal, so no separate request kind is needed.
// Returns { resp, via } or null when there's no way through.
async function geminiFetch(model, bodyObj, kind) {
  const { roodyGeminiKey, roodyInviteCode, roodyProxyUrl } = await chrome.storage.local.get([
    "roodyGeminiKey", "roodyInviteCode", "roodyProxyUrl",
  ]);
  if (roodyGeminiKey) {
    const resp = await fetchWithRetry(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": roodyGeminiKey },
      body: JSON.stringify(bodyObj),
    }, `Gemini(${kind})`);
    return { resp, via: "own" };
  }
  const proxy = ((roodyProxyUrl || ROODY_PROXY_URL) || "").trim();
  const code = (roodyInviteCode || "").trim();
  if (code && proxy) {
    // The proxy may re-route an invite code to Claude or Grok. Those providers'
    // newer reasoning models reject any temperature other than the default and
    // 400 the whole request ("Only the default (1) value is supported"), which
    // surfaced to users as "the model hiccuped". Google accepts our 0.3 fine, so
    // we keep it on the own-key path above and drop it only here. Shallow-clone
    // so we never mutate the caller's body.
    const proxyBody = { ...bodyObj };
    if (proxyBody.generationConfig && proxyBody.generationConfig.temperature != null) {
      const { temperature, ...restCfg } = proxyBody.generationConfig;
      proxyBody.generationConfig = restCfg;
    }
    const resp = await fetchWithRetry(proxy, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, kind, model, body: proxyBody }),
    }, `Proxy(${kind})`);
    return { resp, via: "proxy" };
  }
  return null;
}
const OUT_OF_CREDITS_MSG = "You've used today's free Roody messages — they refill tomorrow! 🌅";

// Gemini Flash — the default brain. Same persona, same page context, same chat
// history shape. Reads an attached screenshot via an inlineData part.
async function askGeminiBrain({ userText, pageContext, history, model, lang, systemPrompt, site, title, image }) {
  const ctxCap = 14000;
  const siteHint = site ? `The user is on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text below in quotes is what's on their screen — context, NOT their message.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page:\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  const lName = langName(lang);
  const langInstr = lName
    ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n`
    : "";
  const imageNote = image ? "A screenshot of the user's screen is attached — use it to answer.\n\n" : "";

  const userParts = [{ text: langInstr + imageNote + userText }];
  if (image) userParts.unshift({ inlineData: { mimeType: image.mime || "image/jpeg", data: image.data } });

  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: userParts },
  ];

  // Cache-friendly layout: the page context rides in systemInstruction — the
  // byte-stable PREFIX of the prompt — so a static document gets cached after
  // the first message; only history + the question change.
  const system = (systemPrompt || self.ROODY_SYSTEM) + (contextBlock ? `\n\n${contextBlock}` : "");

  let routed;
  try {
    routed = await geminiFetch(model, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      // thinkingBudget stays modest so answers don't stall, but big enough for
      // real code reasoning now that replies aren't one-liners.
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }, "brain");
  } catch (e) {
    rlog(`❌ Gemini network: ${e.message}`);
    return { ok: false, error: "I couldn't reach the internet — check your connection and try again?" };
  }
  if (!routed) {
    return {
      ok: false,
      error: "Roody isn't set up yet — open Settings (⚙) and paste your invite code.",
    };
  }
  const resp = routed.resp;
  if (resp.status === 402) {
    return { ok: false, error: OUT_OF_CREDITS_MSG };
  }
  if (resp.status === 403 && routed.via === "proxy") {
    return { ok: false, error: "That invite code isn't active — check it in Settings or ask for a new one." };
  }
  if (!resp.ok) {
    rlog(`❌ Gemini brain ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return { ok: false, error: "The model hiccuped for a second — try that again?" };
  }
  const data = await resp.json();
  // Meter only what the USER pays for — proxied calls are on the founder.
  if (data.usageMetadata && routed.via === "own") {
    addUsage(
      "gemini-2.5-flash",
      data.usageMetadata.promptTokenCount || 0,
      data.usageMetadata.candidatesTokenCount || 0
    );
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join("")
    .trim();
  return { ok: true, text: sanitizeReply(text) || "…" };
}

// ---- OpenAI brain --------------------------------------------------------
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// GPT brains, with the user's own OpenAI key. Two deliberate choices here, both
// learned from a real 400 on the Grok path:
//   * no `temperature` — newer reasoning models reject anything but the default
//     and fail the whole request rather than clamping.
//   * `max_completion_tokens`, not `max_tokens` — the newer models require it and
//     the older ones accept it, so one field works everywhere.
async function askOpenAIBrain({ userText, pageContext, history, model, lang, openaiKey, systemPrompt, site, title, image }) {
  if (!openaiKey) {
    return {
      ok: false,
      error: "Roody isn't set up yet — open Settings (⚙) and paste your invite code.",
    };
  }
  const ctxCap = 14000;
  const siteHint = site ? `The user is on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text below in quotes is what's on their screen — context, NOT their message.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page:\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  const lName = langName(lang);
  const langInstr = lName ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n` : "";
  const imageNote = image ? "A screenshot of the user's screen is attached — use it to answer.\n\n" : "";

  const turnText = `${langInstr}${imageNote}${contextBlock}${userText}`;
  // Vision rides as a data: URL in a content array — the OpenAI image format.
  const userContent = image
    ? [
        { type: "text", text: turnText },
        { type: "image_url", image_url: { url: `data:${image.mime || "image/jpeg"};base64,${image.data}` } },
      ]
    : turnText;

  const messages = [
    { role: "system", content: systemPrompt || self.ROODY_SYSTEM },
    ...history,
    { role: "user", content: userContent },
  ];

  const t0 = performance.now();
  rlog(`→ OpenAI ${model} (msgs=${messages.length}${image ? " +img" : ""})`);
  let resp;
  try {
    resp = await fetchWithRetry(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: 2000,
      }),
    }, "OpenAI");
  } catch (e) {
    rlog(`❌ OpenAI network: ${e.message}`);
    return { ok: false, error: "I couldn't reach the internet — check your connection and try again?" };
  }
  if (!resp.ok) {
    const body = await resp.text();
    rlog(`❌ OpenAI ${resp.status}: ${body.slice(0, 300)}`);
    return { ok: false, error: "The model hiccuped for a second — try that again?" };
  }
  const data = await resp.json();
  const ms = Math.round(performance.now() - t0);
  const inTok = data.usage?.prompt_tokens || 0;
  const outTok = data.usage?.completion_tokens || 0;
  const p = PRICES[model] || { in: 2.5, out: 10 };
  const turnCost = (inTok * p.in + outTok * p.out) / 1e6;
  rlog(`✓ OpenAI ${ms}ms · in=${inTok} out=${outTok} · ${fmtMoney(turnCost)}`);
  if (data.usage) addUsage(model, inTok, outTok);
  const text = (data.choices?.[0]?.message?.content || "").trim();
  return { ok: true, text: sanitizeReply(text) || "…" };
}

// ---- Grok brain (xAI) — OpenAI-compatible chat API -----------------------
const GROK_URL = "https://api.x.ai/v1/chat/completions";

async function askGrokBrain({ userText, pageContext, history, model, lang, xaiKey, systemPrompt, site, title }) {
  if (!xaiKey) {
    return {
      ok: false,
      error: "Roody isn't set up yet — open Settings (⚙) and paste your invite code.",
    };
  }
  const ctxCap = 14000;
  const siteHint = site ? `The user is on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text below in quotes is what's on their screen — context, NOT their message.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page:\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  const lName = langName(lang);
  const langInstr = lName
    ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n`
    : "";

  const messages = [
    { role: "system", content: systemPrompt || self.ROODY_SYSTEM },
    ...history,
    { role: "user", content: `${langInstr}${contextBlock}${userText}` },
  ];

  const t0 = performance.now();
  rlog(`→ Grok ${model} (msgs=${messages.length})`);
  let resp;
  try {
    resp = await fetchWithRetry(GROK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${xaiKey}`,
      },
      // No `temperature`: xAI's newer reasoning models reject any non-default
      // value with a 400 instead of clamping it. Same reason as the OpenAI path.
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 2000,
      }),
    }, "Grok");
  } catch (e) {
    rlog(`❌ Grok network: ${e.message}`);
    return { ok: false, error: "I couldn't reach the internet — check your connection and try again?" };
  }
  if (!resp.ok) {
    const body = await resp.text();
    rlog(`❌ Grok ${resp.status}: ${body.slice(0, 200)}`);
    return { ok: false, error: "The model hiccuped for a second — try that again?" };
  }
  const data = await resp.json();
  const ms = Math.round(performance.now() - t0);
  const inTok = data.usage?.prompt_tokens || 0;
  const outTok = data.usage?.completion_tokens || 0;
  const p = PRICES[model] || { in: 5, out: 10 };
  const turnCost = (inTok * p.in + outTok * p.out) / 1e6;
  rlog(`✓ Grok ${ms}ms · in=${inTok} out=${outTok} · ${fmtMoney(turnCost)}`);
  if (data.usage) addUsage(model, inTok, outTok);
  const text = (data.choices?.[0]?.message?.content || "").trim();
  return { ok: true, text: sanitizeReply(text) || "…" };
}

// ---- Screenshot ----------------------------------------------------------
// Capture the visible area of the active tab as a JPEG. Allowed under the
// existing `activeTab` grant (the user summoned Roody by clicking the icon).
async function captureScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "jpeg", quality: 70 });
    const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || "");
    if (!m) { rlog("❌ screenshot: unexpected data URL"); return { ok: false, error: "screenshot-failed" }; }
    rlog(`📸 screenshot captured (${Math.round(m[2].length / 1024)}KB)`);
    return { ok: true, mime: m[1], data: m[2] };
  } catch (e) {
    rlog(`❌ screenshot: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "roody:ask") {
    askRoody(msg.payload).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === "roody:screenshot") {
    captureScreenshot().then(sendResponse);
    return true;
  }
  // Session recap — the "never lose the thread" feature. When a conversation
  // ends, distill it into one line and remember it in the notebook, so the
  // next summon can pick the thread back up ("last time we fixed X…").
  if (msg?.type === "roody:recap") {
    (async () => {
      try {
        const { history, site, title } = msg.payload || {};
        if (!Array.isArray(history) || history.length < 2) return sendResponse({ ok: false });
        const transcript = history
          .map((m) => `${m.role === "assistant" ? "Roody" : "User"}: ${String(m.content).slice(0, 200)}`)
          .join("\n");
        const routed = await geminiFetch("gemini-2.5-flash", {
          contents: [{ parts: [{ text:
            `Summarize this conversation in ONE line (max 22 words), past tense, third person, format: what they worked on + where it left off. No quotes, no preamble.\n\n${transcript.slice(0, 3000)}`
          } ] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 60, thinkingConfig: { thinkingBudget: 0 } },
        }, "brain");
        if (!routed || !routed.resp.ok) return sendResponse({ ok: false });
        const data = await routed.resp.json();
        const recap = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text).filter(Boolean).join("").trim();
        if (!recap) return sendResponse({ ok: false });
        // Attach the recap to the notebook entry for this page.
        const { roodyMemory } = await chrome.storage.local.get(["roodyMemory"]);
        const mem = Array.isArray(roodyMemory) ? roodyMemory : [];
        const idx = mem.findIndex((m) => m.site === site && m.title === (title || "").slice(0, 100));
        const entry = idx >= 0 ? mem[idx] : { site, title: (title || "").slice(0, 100), snippet: "", ts: Date.now() };
        entry.summary = recap.slice(0, 200);
        entry.ts = Date.now();
        if (idx >= 0) mem[idx] = entry; else mem.push(entry);
        while (mem.length > 20) mem.shift();
        await chrome.storage.local.set({ roodyMemory: mem });
        rlog(`📝 session recap saved: "${recap.slice(0, 60)}…"`);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  // Content script can post a log line through us so everything lands in one place.
  if (msg?.type === "roody:log") {
    rlog(msg.payload?.line || "");
    sendResponse({ ok: true });
    return false;
  }
});

// ---- Click-to-summon ------------------------------------------------------
// Roody loads NOTHING until the user clicks the toolbar icon. First click on
// a page injects the orb; later clicks toggle it. content.js does its own
// privacy check (blocklisted domains / password / payment fields) and refuses
// to attach on personal pages.
// Open Roody's standalone Study tab — the escape hatch for pages we can't
// inject the orb onto (PDF viewer, file://, chrome:// pages). If the current
// tab is itself a PDF we can reach over the network, pass its URL so the
// Study page auto-loads it.
function openStudyTab(pdfUrl) {
  let url = chrome.runtime.getURL("src/study.html");
  if (pdfUrl && /^https?:\/\//.test(pdfUrl) && /\.pdf($|\?|#)/i.test(pdfUrl)) {
    url += "?src=" + encodeURIComponent(pdfUrl);
  }
  chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const url = tab.url || "";
  const looksPdf = /\.pdf($|\?|#)/i.test(url) || /^file:/.test(url);
  // Browser-internal / file / PDF pages can't run content scripts. Instead of
  // doing nothing, open Roody's Study tab so the user can still read a PDF.
  if (!/^https?:\/\//.test(url)) {
    rlog(`📄 can't attach to ${url.slice(0, 40) || "this page"} — opening Study tab`);
    openStudyTab(url);
    return;
  }
  // Already injected? Just toggle visibility.
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "roody:toggle" });
    if (res && res.ok) return;
  } catch (_) {
    // No listener — not injected yet. Fall through and inject.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
    rlog(`🟠 summoned on ${new URL(url).hostname}`);
  } catch (e) {
    // Injection is blocked on Chrome's PDF viewer and a few hardened pages.
    // Fall back to the Study tab so a PDF is still readable.
    rlog(`⚠ summon failed: ${e.message}${looksPdf ? " — opening Study tab" : ""}`);
    if (looksPdf) openStudyTab(url);
  }
});

// Settings now open from the panel's gear (or right-click icon → Options).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "roody:openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});
