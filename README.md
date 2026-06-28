# Roody 🟠

**A calm, read-only AI voice that lives in your code.**

Roody is a Chrome extension that puts a little orb on top of ChatGPT and Claude.
It can **read** the conversation and code on your screen, **talk** with you like a
human — by voice or text — **spot mistakes**, and help you **breathe and reframe**
when you're stuck in a frustrating loop.

The one hard rule: **Roody never edits your code.** It reads, it thinks with you,
it suggests in words. The changes are always yours to make. That's the trust.

```
You, coding ──▶ ChatGPT / Claude in the browser
                      │
                 🟠 Roody (orb overlay)
                      │  reads the page (read-only)
                      │  you talk → it talks back (voice)
                      ▼
                 Claude (Roody's brain)
                 finds mistakes · asks questions · keeps you calm
```

## What works today (Phase 0)

- 🟠 An orb that appears on `chatgpt.com`, `chat.openai.com`, and `claude.ai`
- 👀 Roody reads the conversation/code on the page (read-only)
- 👂 **Live watching** — when ChatGPT/Claude finishes a new answer, Roody notices
  it on its own and chimes in (toggle the 👂 in Roody's header to mute)
- 📜 **Auto-scroll reading** — Roody scrolls the thread to load the full history
  before reading, so it sees the whole conversation, not just the bottom
- 🗣️ Talk to Roody by voice (free browser speech) or by typing — it speaks back
- 🧠 Powered by Claude (`claude-opus-4-8` by default; Sonnet / Haiku selectable)
- 🔒 Read-only by design — there is no code path that edits the page

### How the live watching works

A `MutationObserver` watches the page for changes. When the page goes quiet for
~1.8s (the answer has stopped streaming), Roody treats that as "a new answer
finished," reads it, and reacts. A fingerprint + cooldown stop it from reacting
twice to the same thing, and the 👂 toggle turns it off entirely.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`Roody-ai`).
3. Click the Roody icon in the toolbar → paste your
   [Anthropic API key](https://console.anthropic.com/) → **Save**.
4. Open ChatGPT or Claude. Click the orb in the bottom-right and say hi.

## Roadmap

- **Phase 1 — Eyes on your files.** Read-only folder access (File System Access
  API) so Roody can read your local project, not just the page.
- **Phase 2 — Warmer voice.** Optional premium text-to-speech for a real "Roody
  voice."
- **Phase 3 — The companion brain.** Frustration-loop detection ("breathe, let's
  reframe"), proactive mistake-spotting, and prompt-crafting help.
- **Phase 4 — Side panel.** A dedicated home for Roody beyond the overlay.

## Files

| File | What it is |
|------|------------|
| `manifest.json` | Extension manifest (MV3) |
| `src/persona.js` | Roody's personality (the system prompt) |
| `src/background.js` | Calls Claude, keeps the API key server-side of the page |
| `src/content.js` | The orb, the chat panel, voice in/out, page reading |
| `src/content.css` | Roody's calm look |
| `src/options.html/js` | Settings — API key + model |

## Notes

- Your API key is stored locally in the browser (`chrome.storage.local`) and is
  only sent to Anthropic. For a production release we'd move calls behind a small
  proxy so the key never lives in the browser at all.
