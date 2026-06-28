// Roody's brain-stem: receives messages from the orb, calls Claude, sends the reply back.
importScripts("persona.js");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";

// Pull the user's settings (API key + chosen model) from extension storage.
async function getSettings() {
  const { roodyApiKey, roodyModel } = await chrome.storage.local.get([
    "roodyApiKey",
    "roodyModel",
  ]);
  return { apiKey: roodyApiKey, model: roodyModel || MODEL };
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
        max_tokens: 1024,
        system: self.ROODY_SYSTEM,
        messages,
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
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { ok: true, text: text || "…" };
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
