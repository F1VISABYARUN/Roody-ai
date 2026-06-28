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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "roody:ask") {
    askRoody(msg.payload).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
});

// Clicking the toolbar icon opens Roody's settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
