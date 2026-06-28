// Roody's brain-stem: receives messages from the orb, calls Claude, sends the reply back.
importScripts("persona.js");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Roody just reads and chats — Sonnet is the sweet spot (smart + ~40% cheaper
// than Opus). Users can switch to Haiku (cheaper) or Opus (sharper) in settings.
const MODEL = "claude-sonnet-4-6";

// Pull the user's settings (API key + chosen model) from extension storage.
async function getSettings() {
  const { roodyApiKey, roodyModel } = await chrome.storage.local.get([
    "roodyApiKey",
    "roodyModel",
  ]);
  return { apiKey: roodyApiKey, model: roodyModel || MODEL };
}

// ---- Cost meter -----------------------------------------------------------
// Rough $/1M tokens. Gemini TTS/STT billed approximately by tokens.
const PRICES = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "gemini-tts": { in: 0.5, out: 10 }, // approximate
  "gemini-stt": { in: 0.3, out: 1 }, // approximate
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
};
async function addUsage(model, inTok, outTok) {
  const p = PRICES[model] || { in: 0, out: 0 };
  const cost = (inTok * p.in + outTok * p.out) / 1e6;
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
async function askRoody({ userText, pageContext, history }) {
  const { apiKey, model } = await getSettings();
  if (model && model.startsWith("gemini-")) {
    return askGeminiBrain({ userText, pageContext, history, model });
  }
  if (!apiKey) {
    return {
      ok: false,
      error:
        "I don't have an Anthropic key yet. Open Roody's settings and paste your key — or pick the Gemini brain in the dropdown instead.",
    };
  }

  // The page context rides in the user turn (not the cached system prompt),
  // so it can change every turn without breaking anything.
  const contextBlock = pageContext
    ? `Here is what I can currently see on the page (read-only — the conversation and any code in view):\n\n"""\n${pageContext.slice(0, 14000)}\n"""\n\n`
    : "";

  const messages = [
    ...history,
    { role: "user", content: `${contextBlock}${userText}` },
  ];

  // Web search lets Roody look things up when the page isn't enough. Each
  // search hop adds ~1-3s though — skip if voice mode wants speed.
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
          max_tokens: 400, // short spoken replies — keeps latency + cost low
          temperature: 0.4, // focused, less rambly
          system: self.ROODY_SYSTEM,
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
    rlog(`✓ Claude ${ms}ms · in=${inTok} out=${outTok} · ${data.stop_reason}`);
    if (data.usage) addUsage(model, inTok, outTok);
    const txt = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (txt) finalText = txt;
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    break;
  }
  return { ok: true, text: finalText || "…" };
}

// ---- Gemini voice (Roody's mouth and ears) --------------------------------
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Alternate brain — Gemini Flash, ~10x cheaper than Sonnet. Same persona,
// same page context, same chat history shape.
async function askGeminiBrain({ userText, pageContext, history, model }) {
  const { roodyGeminiKey } = await chrome.storage.local.get(["roodyGeminiKey"]);
  if (!roodyGeminiKey) {
    return {
      ok: false,
      error:
        "Gemini brain selected but no Gemini key — open Roody's settings and paste one (free at aistudio.google.com/apikey).",
    };
  }
  const contextBlock = pageContext
    ? `Here is what I can currently see on the page (read-only):\n\n"""\n${pageContext.slice(0, 14000)}\n"""\n\n`
    : "";

  // Gemini's chat shape: roles are "user" and "model".
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: contextBlock + userText }] },
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
        systemInstruction: { parts: [{ text: self.ROODY_SYSTEM }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
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
  return { ok: true, text: text || "…" };
}

// Text -> speech. Returns base64 PCM (signed 16-bit, mono) + its mime.
async function geminiTTS(text) {
  const { roodyGeminiKey, roodyVoice } = await chrome.storage.local.get([
    "roodyGeminiKey",
    "roodyVoice",
  ]);
  if (!roodyGeminiKey) { rlog("⚠ TTS skipped: no Gemini key → robotic browser voice"); return { ok: false, error: "no-gemini-key" }; }
  const t0 = performance.now();
  rlog(`→ Gemini TTS (${text.length} chars, voice=${roodyVoice || "Kore"})`);

  const body = JSON.stringify({
    contents: [{ parts: [{ text }] }],
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
    geminiTTS(msg.payload.text).then(sendResponse);
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
