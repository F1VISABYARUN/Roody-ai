# Roody 🟠

**A calm, read-only AI voice that lives in your code.**

Roody is a Chrome extension that puts a little orb on top of ChatGPT and Claude.
It reads along with **any** conversation on your screen — code, a recipe, an
essay, a plan, a science question — and **talks** with you like a human, by voice
or text. It's a curious co-thinker: it reacts, asks questions, expands your
thinking, **catches mistakes** (especially in code), and helps you **breathe and
reframe** when you're stuck in a frustrating loop.

It's not just a bug-finder — it's a companion for whatever you're thinking
through. When it *is* code, it gets extra sharp about errors and loops.

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
- 🗣️ Talk to Roody by voice or by typing — it speaks back
- 🎙️ **Warm voice via Gemini** (optional) — add a Google Gemini key and Roody
  gets a natural voice (TTS) and better listening (STT). No key? It falls back
  to the free browser voice automatically.
- 🧠 **Brain: Claude** (`claude-opus-4-8` by default; Sonnet / Haiku selectable)
  — the sharpest reasoning for reading code and finding mistakes
- 🔒 Read-only by design — there is no code path that edits the page

### Roody's brain vs Roody's voice

These are deliberately separate so you can use the best of each:

| | Powered by | What it does |
|---|---|---|
| **Brain** | Claude | Reads your code, finds bugs, asks the smart questions |
| **Voice** | Gemini (or free browser) | Speaks Roody's words, listens to yours |

The Anthropic key drives the brain; the optional Gemini key drives the voice
(`gemini-2.5-flash-preview-tts` for speaking, `gemini-2.5-flash` for listening).

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
