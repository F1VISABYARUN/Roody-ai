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

// Ask Claude. `pageContext` is the read-only text Roody scraped from the page;
// `history` is the running chat between the human and Roody.
async function askRoody({ userText, pageContext, history }) {
  const { apiKey, model } = await getSettings();
  if (!apiKey) {
    return {
      ok: false,
      error:
        "I don't have an API key yet. Open Roody's settings (click the extension icon) and paste your Anthropic key so I can think.",
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

  // Web search lets Roody look things up when the page isn't enough.
  const { roodyWebSearch } = await chrome.storage.local.get(["roodyWebSearch"]);
  const tools =
    roodyWebSearch !== false
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]
      : undefined;

  // Server-side search runs a loop; if it pauses, re-send to let it continue.
  let finalText = "";
  for (let i = 0; i < 4; i++) {
    let resp;
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
      return { ok: false, error: `I couldn't reach the network. (${e.message})` };
    }
    if (!resp.ok) {
      const body = await resp.text();
      return {
        ok: false,
        error: `Something went wrong talking to Claude (${resp.status}). ${body.slice(0, 200)}`,
      };
    }
    const data = await resp.json();
    if (data.usage) {
      addUsage(model, data.usage.input_tokens || 0, data.usage.output_tokens || 0);
    }
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

// Text -> speech. Returns base64 PCM (signed 16-bit, mono) + its mime.
async function geminiTTS(text) {
  const { roodyGeminiKey, roodyVoice } = await chrome.storage.local.get([
    "roodyGeminiKey",
    "roodyVoice",
  ]);
  if (!roodyGeminiKey) return { ok: false, error: "no-gemini-key" };

  let resp;
  try {
    resp = await fetch(
      `${GEMINI_BASE}/gemini-2.5-flash-preview-tts:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": roodyGeminiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: roodyVoice || "Kore" },
              },
            },
          },
        }),
      }
    );
  } catch (e) {
    return { ok: false, error: `tts-network ${e.message}` };
  }
  if (!resp.ok) {
    return { ok: false, error: `tts ${resp.status} ${(await resp.text()).slice(0, 160)}` };
  }
  const data = await resp.json();
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
  if (!part) return { ok: false, error: "tts-no-audio" };
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
});

// Clicking the toolbar icon opens Roody's settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
