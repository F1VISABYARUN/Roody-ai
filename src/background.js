// Roody's brain-stem: receives messages from the orb, calls Claude, sends the reply back.
try { importScripts("persona.js"); } catch (_) { importScripts("src/persona.js"); }

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Roody just reads and chats — Sonnet is the sweet spot (smart + ~40% cheaper
// than Opus). Users can switch to Haiku (cheaper) or Opus (sharper) in settings.
const MODEL = "claude-sonnet-4-6";

// Pull the user's settings (API key + chosen model) from extension storage.
async function getSettings() {
  const { roodyApiKey, roodyModel, roodyXaiKey } = await chrome.storage.local.get([
    "roodyApiKey",
    "roodyModel",
    "roodyXaiKey",
  ]);
  return { apiKey: roodyApiKey, xaiKey: roodyXaiKey, model: roodyModel || MODEL };
}

// ---- Cost meter -----------------------------------------------------------
// USD → INR conversion. Approximate; refresh manually when needed.
const USD_TO_INR = 85;
const fmtMoney = (usd) => `$${usd.toFixed(4)} · ₹${(usd * USD_TO_INR).toFixed(2)}`;
// Rough $/1M tokens. Gemini TTS/STT billed approximately by tokens.
const PRICES = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "gemini-tts": { in: 0.5, out: 10 }, // approximate
  "gemini-stt": { in: 0.3, out: 1 }, // approximate
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  // ElevenLabs free tier = 10k credits/month, $0 out of pocket. We track
  // CREDITS (≈characters) separately in roodyElevenChars, NOT as dollars —
  // counting them as money was inflating the spend meter ~4x.
  "elevenlabs": { in: 0, out: 0 },
  "grok-3": { in: 3, out: 15 },
  "grok-3-mini": { in: 0.3, out: 0.5 },
  "grok-3-mini-fast": { in: 0.3, out: 0.5 },
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

// Ask Roody's brain. Routes to Claude or Gemini depending on which model is
// selected in settings. `pageContext` is the read-only text Roody scraped from
// the page; `history` is the running chat between the human and Roody.
// `mode === "voice"` triggers speed-tuned settings: no web search, fewer tokens,
// shorter history, stricter "one spoken sentence" instruction.
const LANG_NAMES = {
  "te": "Telugu", "hi": "Hindi", "ta": "Tamil", "kn": "Kannada", "ml": "Malayalam",
  "es": "Spanish", "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
};
function langName(code) {
  if (!code) return null;
  const short = code.split("-")[0];
  return LANG_NAMES[short] || null;
}

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
    return `- [${when}] ${m.site} · "${m.title}" — ${(m.snippet || "").slice(0, 120)}`;
  });
  return `\nYour running notebook of the user's recent activity (only pages where they engaged with you):\n${lines.join("\n")}\n\n`;
}

// User's own "about me" — a small text they can set in Settings so Roody
// actually knows who they are. Prepended to the system prompt.
function buildProfileBlock(profile) {
  const p = (profile || "").trim();
  if (!p) return "";
  return `About the user (what they told you about themselves):\n"${p.slice(0, 500)}"\n\n`;
}

async function askRoody({ userText, pageContext, history, mode, site, title }) {
  const { apiKey, xaiKey, model: settingsModel } = await getSettings();
  const { roodyVoiceCheapBrain, roodyLang, roodyVibe, roodyMemory, roodyProfile } = await chrome.storage.local.get(["roodyVoiceCheapBrain", "roodyLang", "roodyVibe", "roodyMemory", "roodyProfile"]);
  const useCheap = mode === "voice" && roodyVoiceCheapBrain !== false;
  // Cheap voice brain only applies within the same provider — don't override
  // Gemini/Grok to Claude Haiku (user might not have a Claude key).
  let model = settingsModel;
  if (useCheap) {
    if (settingsModel.startsWith("gemini-")) model = "gemini-2.5-flash";
    else if (settingsModel.startsWith("grok-")) model = "grok-3-mini-fast";
    else model = "claude-haiku-4-5";
  }
  const baseSystem = getSystemPrompt(roodyVibe || "normal");
  const profileBlock = buildProfileBlock(roodyProfile);
  const memoryBlock = buildMemoryBlock(roodyMemory);
  // Prompt-caching split:
  //   stable part = persona + vibe + profile (rarely changes → gets cached
  //     at 90% off for 5 min after the first call)
  //   dynamic part = memory (updates every turn → NOT cached)
  // The full string is still assembled for Gemini/Grok which don't cache the
  // same way.
  const stableSystem = profileBlock + baseSystem;
  const systemPrompt = profileBlock + memoryBlock + baseSystem;

  // Gemini brain
  if (model && model.startsWith("gemini-")) {
    return askGeminiBrain({ userText, pageContext, history, model, mode, lang: roodyLang, systemPrompt, site, title });
  }
  // Grok brain
  if (model && model.startsWith("grok-")) {
    return askGrokBrain({ userText, pageContext, history, model, mode, lang: roodyLang, xaiKey, systemPrompt, site, title });
  }
  if (!apiKey) {
    return {
      ok: false,
      error:
        "I don't have an Anthropic key yet. Open Roody's settings and paste your key — or pick the Gemini brain in the dropdown instead.",
    };
  }

  const isVoice = mode === "voice";
  // "Analyze mode" — user explicitly asked for deeper thinking. Unlocks a
  // longer format (3-4 sentences) and bigger page context. Regular voice
  // chatter stays snappy.
  const wantsAnalysis = /\b(analy[sz]e|analysis|what do you think|what's your take|break (this|it) down|review|explain (this|it|the (page|article))|deep dive|dive in(to)?|insight|thoughts on|look (at|closer))\b/i.test(userText || "");

  // Voice turns get a much smaller page context (1500 chars vs 14000) — the
  // recent task is what matters when talking. Text turns can keep more.
  const ctxCap = isVoice ? (wantsAnalysis ? 6000 : 1500) : 14000;
  const siteHint = site ? `You are watching the user on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text in quotes below is what they can see right now — it is NOT a message from them, it is the page they are looking at.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page (read-only, may include the user's other AI chat):\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  // Voice turns: explicit "speak briefly" instruction. Analyze mode unlocks
  // 3-4 sentences of real insight instead of a one-liner summary.
  const voiceInstr = isVoice
    ? (wantsAnalysis
        ? "The user asked you to analyze/think about the page. Reply in 3-4 spoken sentences with a REAL take — insights, connections, opinions, or what stands out. Don't just describe what's on the page; give your view. End with proper punctuation. No lists, no markdown — read aloud.\n\n"
        : "Reply in ONE complete short sentence (max 15 words). Snappy and finished — end with punctuation, never trail off. No lists, no markdown — read aloud.\n\n")
    : "";
  // Language instruction: if non-English, tell the brain to reply in that language.
  const lName = langName(roodyLang);
  const langInstr = lName
    ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n`
    : "";
  const trimmedHistory = isVoice ? history.slice(-4) : history;

  const messages = [
    ...trimmedHistory,
    { role: "user", content: `${langInstr}${voiceInstr}${contextBlock}${userText}` },
  ];

  // Web search is great for text mode but tanks voice-mode latency (~1-3s per
  // hop) AND can balloon input tokens to 20k+. Always off in voice mode.
  const { roodyWebSearch } = await chrome.storage.local.get(["roodyWebSearch"]);
  const tools =
    !isVoice && roodyWebSearch !== false
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]
      : undefined;

  // Server-side search runs a loop; if it pauses, re-send to let it continue.
  let finalText = "";
  for (let i = 0; i < 4; i++) {
    let resp;
    const t0 = performance.now();
    rlog(`→ Claude ${model} (msgs=${messages.length}${tools ? " +web" : ""})`);
    try {
      resp = await fetch(ANTHROPIC_URL, {
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
          max_tokens: isVoice ? (wantsAnalysis ? 220 : 60) : 400,
          temperature: 0.4,
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
      });
    } catch (e) {
      rlog(`❌ Claude network: ${e.message}`);
      return { ok: false, error: `I couldn't reach the network. (${e.message})` };
    }
    if (!resp.ok) {
      const body = await resp.text();
      rlog(`❌ Claude ${resp.status}: ${body.slice(0, 120)}`);
      return {
        ok: false,
        error: `Something went wrong talking to Claude (${resp.status}). ${body.slice(0, 200)}`,
      };
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
  return { ok: true, text: sanitizeReply(finalText) || "…" };
}

// Catch obvious LLM truncation — replies that end mid-word or with a dangling
// contraction. When this happens, tack on a graceful ending so the user hears
// a complete thought instead of "Okay, we'" hanging in the air.
function sanitizeReply(txt) {
  if (!txt) return txt;
  const trimmed = txt.trim();
  // Ends properly with punctuation → looks complete
  if (/[.!?…"'\)\]]$/.test(trimmed)) return trimmed;
  // Ends with a contraction apostrophe or dash → truncated
  if (/[a-z]['\-]$/i.test(trimmed) || /\b(I|we|you|it|they|he|she)$/i.test(trimmed)) {
    return trimmed + "… let me try that again.";
  }
  // Otherwise just add a period so TTS reads it as a finished sentence
  return trimmed + ".";
}

// ---- ElevenLabs voice (premium TTS — most human, sub-second) -------------
// If a key is set in settings, Roody uses ElevenLabs instead of Gemini TTS.
// Flash v2.5 model = lowest latency (~75-300 ms) at solid quality.
const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
async function elevenLabsTTS(text) {
  const { roodyElevenKey, roodyElevenVoice, roodyVibe } = await chrome.storage.local.get([
    "roodyElevenKey",
    "roodyElevenVoice",
    "roodyVibe",
  ]);
  if (!roodyElevenKey) return { ok: false, error: "no-eleven-key" };
  const voiceId = roodyElevenVoice || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const vibe = roodyVibe || "normal";
  const voiceSettings = SIDEKICK_ELEVEN_SETTINGS[vibe] || SIDEKICK_ELEVEN_SETTINGS.normal;
  const t0 = performance.now();
  rlog(`→ ElevenLabs TTS (${text.length} chars, voice=${voiceId.slice(0, 8)}…, vibe=${vibe})`);
  try {
    const resp = await fetch(
      `${ELEVEN_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: {
          "xi-api-key": roodyElevenKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: voiceSettings,
        }),
      }
    );
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 200);
      rlog(`❌ ElevenLabs ${resp.status}: ${body}`);
      return { ok: false, error: `el ${resp.status} ${body}` };
    }
    const buf = await resp.arrayBuffer();
    const ms = Math.round(performance.now() - t0);
    rlog(`✓ ElevenLabs ${ms}ms · ${Math.round(buf.byteLength / 1024)}KB`);
    // base64-encode the MP3 bytes for transit to the content script
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { ok: true, audioBase64: btoa(bin), mime: "audio/mpeg" };
  } catch (e) {
    rlog(`❌ ElevenLabs network: ${e.message}`);
    return { ok: false, error: `el-net ${e.message}` };
  }
}

// ---- Gemini voice (Roody's mouth and ears) --------------------------------
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Alternate brain — Gemini Flash, ~10x cheaper than Sonnet. Same persona,
// same page context, same chat history shape.
async function askGeminiBrain({ userText, pageContext, history, model, mode, lang, systemPrompt, site, title }) {
  const { roodyGeminiKey } = await chrome.storage.local.get(["roodyGeminiKey"]);
  if (!roodyGeminiKey) {
    return {
      ok: false,
      error:
        "Gemini brain selected but no Gemini key — open Roody's settings and paste one (free at aistudio.google.com/apikey).",
    };
  }
  const isVoice = mode === "voice";
  const wantsAnalysis = /\b(analy[sz]e|analysis|what do you think|what's your take|break (this|it) down|review|explain (this|it|the (page|article))|deep dive|dive in(to)?|insight|thoughts on|look (at|closer))\b/i.test(userText || "");
  const ctxCap = isVoice ? (wantsAnalysis ? 6000 : 1500) : 14000;
  const siteHint = site ? `You are watching the user on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text below in quotes is what they see — NOT their message.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page:\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  const voiceInstr = isVoice
    ? (wantsAnalysis
        ? "The user asked you to analyze the page. Reply in 3-4 spoken sentences with a REAL take — insights, opinions, or connections. Don't just describe. Read aloud, no lists/markdown.\n\n"
        : "Reply in ONE complete short sentence (max 15 words). Snappy and finished — end with punctuation, never trail off. No lists, no markdown — read aloud.\n\n")
    : "";
  const lName = langName(lang);
  const langInstr = lName
    ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n`
    : "";
  const trimmedHistory = isVoice ? history.slice(-4) : history;

  const contents = [
    ...trimmedHistory.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: langInstr + voiceInstr + contextBlock + userText }] },
  ];

  let resp;
  try {
    resp = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": roodyGeminiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt || self.ROODY_SYSTEM }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: isVoice ? (wantsAnalysis ? 220 : 60) : 400 },
      }),
    });
  } catch (e) {
    return { ok: false, error: `Couldn't reach Gemini. (${e.message})` };
  }
  if (!resp.ok) {
    return {
      ok: false,
      error: `Gemini brain error ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
    };
  }
  const data = await resp.json();
  if (data.usageMetadata) {
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

// ---- Grok brain (xAI) — OpenAI-compatible chat API -----------------------
const GROK_URL = "https://api.x.ai/v1/chat/completions";

async function askGrokBrain({ userText, pageContext, history, model, mode, lang, xaiKey, systemPrompt, site, title }) {
  if (!xaiKey) {
    return {
      ok: false,
      error: "Grok brain selected but no xAI key — open Roody's settings and paste one from console.x.ai.",
    };
  }
  const isVoice = mode === "voice";
  const wantsAnalysis = /\b(analy[sz]e|analysis|what do you think|what's your take|break (this|it) down|review|explain (this|it|the (page|article))|deep dive|dive in(to)?|insight|thoughts on|look (at|closer))\b/i.test(userText || "");
  const ctxCap = isVoice ? (wantsAnalysis ? 6000 : 1500) : 14000;
  const siteHint = site ? `You are watching the user on ${site}${title ? ` (page title: "${title.slice(0, 80)}")` : ""}. The text below in quotes is what they see — NOT their message.\n\n` : "";
  const contextBlock = pageContext
    ? `${siteHint}Here is what is on the page:\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : siteHint;
  const voiceInstr = isVoice
    ? (wantsAnalysis
        ? "The user asked you to analyze the page. Reply in 3-4 spoken sentences with a REAL take. Read aloud, no lists.\n\n"
        : "Reply in ONE complete short sentence (max 15 words). Snappy and finished — end with punctuation, never trail off. No lists, no markdown — read aloud.\n\n")
    : "";
  const lName = langName(lang);
  const langInstr = lName
    ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n`
    : "";
  const trimmedHistory = isVoice ? history.slice(-4) : history;

  const messages = [
    { role: "system", content: systemPrompt || self.ROODY_SYSTEM },
    ...trimmedHistory,
    { role: "user", content: `${langInstr}${voiceInstr}${contextBlock}${userText}` },
  ];

  const t0 = performance.now();
  rlog(`→ Grok ${model} (msgs=${messages.length})`);
  let resp;
  try {
    resp = await fetch(GROK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${xaiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: isVoice ? (wantsAnalysis ? 220 : 60) : 400,
        temperature: 0.5,
      }),
    });
  } catch (e) {
    rlog(`❌ Grok network: ${e.message}`);
    return { ok: false, error: `Couldn't reach Grok. (${e.message})` };
  }
  if (!resp.ok) {
    const body = await resp.text();
    rlog(`❌ Grok ${resp.status}: ${body.slice(0, 120)}`);
    return { ok: false, error: `Grok error ${resp.status}: ${body.slice(0, 200)}` };
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

// Character voice styles — Gemini TTS responds to acting direction in the
// prompt. Each sidekick gets a distinct voice personality so the same TTS
// voice actually SOUNDS different when the character is "speaking."
const SIDEKICK_TTS_STYLES = {
  normal: "Say this warmly, casually, like a close friend chatting — with natural pauses and a soft, friendly tone",
  minion: "Perform this like a small, silly, hyperactive creature. Use a HIGH-PITCHED, squeaky, excited voice. Speed up on the silly gibberish words. Sound goofy, chaotic, and adorable — like a tiny yellow creature who doesn't fully understand what's happening but is VERY enthusiastic about it",
  roadrunner: "Perform this with bursts of extreme speed and energy. The 'MEEP MEEP' parts should be sharp, quick, and high-pitched. Normal parts are calm, then suddenly ZOOM — fast and energetic. Big contrast between calm narration and explosive speed moments",
  coyote: "Perform this like a dramatic narrator telling a tragic comedy. Sound sophisticated and scheming during the planning parts — then shift to deadpan disappointment when things fail. Think of a genius whose plans always backfire. Dry humor, dramatic pauses before the disaster",
  pinkpanther: "Perform this in a smooth, cool, suave voice — like a secret agent. Slow, deliberate, dripping with style. The 'dun dun dun dun' theme parts should be musical and sly. Everything sounds effortlessly cool and mysterious",
  woody: "Perform this like a cheerful, bold cowboy. Warm, friendly, but COMMANDING when rallying the team. The catchphrases like 'there's a snake in my boot' should be enthusiastic and slightly startled. Overall: loyal, brave, heart-of-gold cowboy energy",
  rapunzel: "Perform this with OVERWHELMING excitement and wonder. High energy, breathless amazement at everything. Like someone seeing the world for the first time and finding it MAGICAL. Genuine, bright, can't-contain-the-joy enthusiasm. Sing-songy on the musical parts",
  snowwhite: "Perform this in a sweet, gentle, melodic voice — almost singing. Soft and kind, like talking to forest animals. The singing parts should actually sound musical and lilting. Warm, motherly, impossibly gentle and caring",
  tom: "Perform this with big dramatic physical comedy energy. The crash and slapstick moments should be loud and startled — WHAM! OOF! Scheming parts are whispered and sneaky. Big contrast: sneaky quiet... then LOUD crash. Think cartoon cat energy",
  jerry: "Perform this with clever, smug, mischievous energy. Quick and nimble — short sharp sounds. The victory moments should be tiny and triumphant. Overall: small but brilliant, self-satisfied, the smartest one in the room and knows it",
};

// ElevenLabs voice_settings tweaks per sidekick — makes the same voice
// more expressive/chaotic for character moments.
const SIDEKICK_ELEVEN_SETTINGS = {
  normal:      { stability: 0.5,  similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
  minion:      { stability: 0.2,  similarity_boost: 0.5,  style: 0.9,  use_speaker_boost: true },
  roadrunner:  { stability: 0.25, similarity_boost: 0.6,  style: 0.85, use_speaker_boost: true },
  coyote:      { stability: 0.4,  similarity_boost: 0.7,  style: 0.6,  use_speaker_boost: true },
  pinkpanther: { stability: 0.6,  similarity_boost: 0.8,  style: 0.5,  use_speaker_boost: true },
  woody:       { stability: 0.35, similarity_boost: 0.7,  style: 0.7,  use_speaker_boost: true },
  rapunzel:    { stability: 0.2,  similarity_boost: 0.6,  style: 0.9,  use_speaker_boost: true },
  snowwhite:   { stability: 0.55, similarity_boost: 0.8,  style: 0.5,  use_speaker_boost: true },
  tom:         { stability: 0.15, similarity_boost: 0.5,  style: 0.95, use_speaker_boost: true },
  jerry:       { stability: 0.3,  similarity_boost: 0.6,  style: 0.8,  use_speaker_boost: true },
};

// Text -> speech. Returns base64 PCM (signed 16-bit, mono) + its mime.
async function geminiTTS(text) {
  const { roodyGeminiKey, roodyVoice, roodyVibe } = await chrome.storage.local.get([
    "roodyGeminiKey",
    "roodyVoice",
    "roodyVibe",
  ]);
  if (!roodyGeminiKey) { rlog("⚠ TTS skipped: no Gemini key → robotic browser voice"); return { ok: false, error: "no-gemini-key" }; }
  const vibe = roodyVibe || "normal";
  const t0 = performance.now();
  rlog(`→ Gemini TTS (${text.length} chars, voice=${roodyVoice || "Kore"}, vibe=${vibe})`);

  const styleDirective = SIDEKICK_TTS_STYLES[vibe] || SIDEKICK_TTS_STYLES.normal;
  const styled = `${styleDirective} (do not say this instruction, just perform what follows):\n\n${text}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: styled }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: roodyVoice || "Kore" },
        },
      },
    },
  });

  // One attempt + one retry on 500/503/429 — Gemini TTS is flaky under load.
  async function attempt(n) {
    let resp;
    try {
      resp = await fetch(
        `${GEMINI_BASE}/gemini-2.5-flash-preview-tts:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": roodyGeminiKey },
          body,
        }
      );
    } catch (e) {
      rlog(`❌ TTS network${n > 1 ? " (retry)" : ""}: ${e.message}`);
      return { transient: true, error: `tts-network ${e.message}` };
    }
    if (resp.ok) return { resp };
    const txt = (await resp.text()).slice(0, 160);
    const transient = resp.status === 500 || resp.status === 503 || resp.status === 429;
    rlog(`❌ TTS ${resp.status}${n > 1 ? " (retry)" : ""}: ${txt}`);
    return { transient, status: resp.status, error: `tts ${resp.status} ${txt}` };
  }

  let r = await attempt(1);
  if (!r.resp && r.transient) {
    rlog("↻ retrying TTS after transient error…");
    await new Promise((res) => setTimeout(res, 400));
    r = await attempt(2);
  }
  if (!r.resp) {
    rlog("⚠ Gemini TTS failed twice → falling back to robotic browser voice");
    return { ok: false, error: r.error };
  }
  const resp = r.resp;
  const data = await resp.json();
  const ms = Math.round(performance.now() - t0);
  if (data.usageMetadata) {
    addUsage(
      "gemini-tts",
      data.usageMetadata.promptTokenCount || 0,
      data.usageMetadata.candidatesTokenCount || 0
    );
  }
  const part = (data?.candidates?.[0]?.content?.parts || []).find(
    (p) => p.inlineData
  );
  if (!part) { rlog(`❌ TTS no audio in response (${ms}ms)`); return { ok: false, error: "tts-no-audio" }; }
  rlog(`✓ TTS ${ms}ms · ${Math.round(part.inlineData.data.length / 1024)}KB`);
  return { ok: true, audioBase64: part.inlineData.data, mime: part.inlineData.mimeType };
}

// Speech -> text. Takes base64 audio + its mime, returns the transcript.
async function geminiSTT({ audioBase64, mime }) {
  const { roodyGeminiKey } = await chrome.storage.local.get(["roodyGeminiKey"]);
  if (!roodyGeminiKey) return { ok: false, error: "no-gemini-key" };

  let resp;
  try {
    resp = await fetch(`${GEMINI_BASE}/gemini-2.5-flash:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": roodyGeminiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Transcribe this audio to plain text. Return ONLY the exact words spoken — no commentary, no quotes.",
              },
              { inlineData: { mimeType: mime, data: audioBase64 } },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return { ok: false, error: `stt-network ${e.message}` };
  }
  if (!resp.ok) {
    return { ok: false, error: `stt ${resp.status}` };
  }
  const data = await resp.json();
  if (data.usageMetadata) {
    addUsage(
      "gemini-stt",
      data.usageMetadata.promptTokenCount || 0,
      data.usageMetadata.candidatesTokenCount || 0
    );
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join(" ")
    .trim();
  return { ok: true, text };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "roody:ask") {
    askRoody(msg.payload).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === "roody:tts") {
    // Prefer ElevenLabs (premium, sub-second, human) when its key is set.
    // Fall through to Gemini TTS only if it could plausibly succeed (a Gemini
    // key is set). Otherwise surface the ElevenLabs error so the user can see
    // what's wrong instead of silently getting the robotic browser voice.
    (async () => {
      const { roodyElevenKey, roodyGeminiKey } = await chrome.storage.local.get([
        "roodyElevenKey",
        "roodyGeminiKey",
      ]);
      rlog(`TTS request: eleven=${roodyElevenKey ? "yes" : "no"} gemini=${roodyGeminiKey ? "yes" : "no"}`);
      if (roodyElevenKey) {
        const r = await elevenLabsTTS(msg.payload.text);
        if (r.ok) {
          // Track free-tier credits (≈chars), not dollars.
          const { roodyElevenChars } = await chrome.storage.local.get(["roodyElevenChars"]);
          await chrome.storage.local.set({ roodyElevenChars: (roodyElevenChars || 0) + msg.payload.text.length });
          return sendResponse(r);
        }
        if (!roodyGeminiKey) {
          // No backup possible — return the real ElevenLabs error so the user
          // sees it in the bubble instead of silently getting robotic voice.
          rlog(`⚠ ElevenLabs failed and no Gemini backup: ${r.error}`);
          return sendResponse({ ok: false, error: `ElevenLabs: ${r.error}` });
        }
        rlog("↻ ElevenLabs failed, trying Gemini TTS as backup");
      }
      sendResponse(await geminiTTS(msg.payload.text));
    })();
    return true;
  }
  if (msg?.type === "roody:stt") {
    geminiSTT(msg.payload).then(sendResponse);
    return true;
  }
  // Content script can post a log line through us so everything lands in one place.
  if (msg?.type === "roody:log") {
    rlog(msg.payload?.line || "");
    sendResponse({ ok: true });
    return false;
  }
});

// Clicking the toolbar icon opens Roody's settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
