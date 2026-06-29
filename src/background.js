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
  // ElevenLabs charges per character, not per token. We track chars in "out"
  // slot (input chars are 0) at ~$0.30/1k chars = $300/1M for the Creator tier.
  "elevenlabs": { in: 0, out: 300 },
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
// `mode === "voice"` triggers speed-tuned settings: no web search, fewer tokens,
// shorter history, stricter "one spoken sentence" instruction.
async function askRoody({ userText, pageContext, history, mode }) {
  const { apiKey, model: settingsModel } = await getSettings();
  // Voice mode can opt-in to a cheaper/faster brain (Haiku) regardless of
  // what's selected for text mode. ~3x cheaper, similar quality for the short
  // spoken replies voice mode produces.
  const { roodyVoiceCheapBrain } = await chrome.storage.local.get(["roodyVoiceCheapBrain"]);
  const useCheap = mode === "voice" && roodyVoiceCheapBrain !== false;
  const model = useCheap ? "claude-haiku-4-5" : settingsModel;

  if (model && model.startsWith("gemini-")) {
    return askGeminiBrain({ userText, pageContext, history, model, mode });
  }
  if (!apiKey) {
    return {
      ok: false,
      error:
        "I don't have an Anthropic key yet. Open Roody's settings and paste your key — or pick the Gemini brain in the dropdown instead.",
    };
  }

  const isVoice = mode === "voice";

  // Voice turns get a much smaller page context (1500 chars vs 14000) — the
  // recent task is what matters when talking. Text turns can keep more.
  const ctxCap = isVoice ? 1500 : 14000;
  const contextBlock = pageContext
    ? `Here is what I can currently see on the page (read-only — the conversation and any code in view):\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : "";
  // Voice turns: explicit "speak briefly" instruction prefixed to the message.
  const voiceInstr = isVoice
    ? "Reply in ONE short spoken sentence (ideally under 25 words). No lists, no headings, no markdown — this will be read aloud.\n\n"
    : "";
  // Voice turns: keep only the last 4 messages of history (2 turns). Text
  // turns keep the full history.
  const trimmedHistory = isVoice ? history.slice(-4) : history;

  const messages = [
    ...trimmedHistory,
    { role: "user", content: `${voiceInstr}${contextBlock}${userText}` },
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
          // Voice mode = 150 tokens (≈80 words). Text mode = 400.
          // Less text → much faster TTS (Gemini scales at ~50ms/char).
          max_tokens: isVoice ? 150 : 400,
          temperature: 0.4,
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
    const p = PRICES[model] || { in: 0, out: 0 };
    const turnCost = ((inTok * p.in + outTok * p.out) / 1e6).toFixed(4);
    rlog(`✓ Claude ${ms}ms · in=${inTok} out=${outTok} · $${turnCost} · ${data.stop_reason}`);
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

// ---- ElevenLabs voice (premium TTS — most human, sub-second) -------------
// If a key is set in settings, Roody uses ElevenLabs instead of Gemini TTS.
// Flash v2.5 model = lowest latency (~75-300 ms) at solid quality.
const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
async function elevenLabsTTS(text) {
  const { roodyElevenKey, roodyElevenVoice } = await chrome.storage.local.get([
    "roodyElevenKey",
    "roodyElevenVoice",
  ]);
  if (!roodyElevenKey) return { ok: false, error: "no-eleven-key" };
  const voiceId = roodyElevenVoice || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const t0 = performance.now();
  rlog(`→ ElevenLabs TTS (${text.length} chars, voice=${voiceId.slice(0, 8)}…)`);
  try {
    const resp = await fetch(
      `${ELEVEN_BASE}/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
      {
        method: "POST",
        headers: {
          "xi-api-key": roodyElevenKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5", // fastest model
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
async function askGeminiBrain({ userText, pageContext, history, model, mode }) {
  const { roodyGeminiKey } = await chrome.storage.local.get(["roodyGeminiKey"]);
  if (!roodyGeminiKey) {
    return {
      ok: false,
      error:
        "Gemini brain selected but no Gemini key — open Roody's settings and paste one (free at aistudio.google.com/apikey).",
    };
  }
  const isVoice = mode === "voice";
  const ctxCap = isVoice ? 1500 : 14000;
  const contextBlock = pageContext
    ? `Here is what I can currently see on the page (read-only):\n\n"""\n${pageContext.slice(0, ctxCap)}\n"""\n\n`
    : "";
  const voiceInstr = isVoice
    ? "Reply in ONE short spoken sentence (under 25 words). No lists, no markdown — read aloud.\n\n"
    : "";
  const trimmedHistory = isVoice ? history.slice(-4) : history;

  // Gemini's chat shape: roles are "user" and "model".
  const contents = [
    ...trimmedHistory.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: voiceInstr + contextBlock + userText }] },
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
        generationConfig: { temperature: 0.4, maxOutputTokens: isVoice ? 150 : 400 },
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
    // Prefer ElevenLabs (premium, sub-second, human) when its key is set.
    // Fall through to Gemini TTS otherwise. Each function handles its own
    // "no key" early-return, so this works in any combination.
    (async () => {
      const { roodyElevenKey } = await chrome.storage.local.get(["roodyElevenKey"]);
      if (roodyElevenKey) {
        const r = await elevenLabsTTS(msg.payload.text);
        if (r.ok) {
          addUsage("elevenlabs", 0, msg.payload.text.length);
          return sendResponse(r);
        }
        // If ElevenLabs failed, try Gemini as a backup so we don't fall to robot.
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
