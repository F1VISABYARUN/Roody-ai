# Roody &lt;/&gt;

**A transparent, read-only AI coding assistant that lives on any page.**

Roody is a Chrome extension that puts a glass orb on top of whatever you're
working on. It reads what's on your screen — the code and text on the page, and,
when you ask, a **screenshot** of the actual screen — then answers your questions
and **writes code**, all in the chat. No voice, no clutter: you type, it replies
in formatted Markdown with real, runnable code blocks.

```
You, on any page ──▶ code · docs · an error · a rendered app
                          │
                     </> Roody (glass orb overlay)
                          │  reads the page (read-only)
                          │  optionally captures a screenshot
                          ▼
                     Gemini / Claude / Grok (Roody's brain)
                     answers questions · writes code · spots bugs
```

## What Roody does

- **</> Answers &amp; writes code.** Ask about a bug, an error, or an approach —
  Roody replies in the chat with real code in copy-able, syntax-friendly blocks.
- **👀 Reads the page with you.** Code on GitHub, Stack Overflow, docs, editors,
  articles, and PDFs. Summon Roody and ask "what's wrong here?"
- **📷 Sees your screen.** Tap the camera (or ask about something visual) and
  Roody captures a screenshot of the current tab and sends it to a vision model,
  so it can read diagrams, rendered UIs, and error dialogs — not just text.
- **🧠 Pick your brain.** Gemini 2.5 Flash by default (cheap &amp; multimodal);
  **OpenAI (GPT-4o / 4.1), Claude, and Grok** selectable with your own key. A
  screenshot on a text-only brain is routed to Gemini vision automatically, and a
  missing key falls back to Gemini instead of erroring.
- **🌏 Answers in your language.** English, Telugu, Hindi, Tamil, and more.
- **🔒 Read-only by design.** Roody never edits, clicks, or types on the page, and
  it refuses to run on banking, email, chat, and other personal pages.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`Roody-ai`).
3. Click the Roody icon in the toolbar → paste your **invite code** (or a free
   [Gemini API key](https://aistudio.google.com/apikey)) in Settings.
4. Open any work page, click the orb, and ask away.

## How it works

- **Click-to-summon.** Nothing loads until you click the toolbar icon; the content
  script is injected on demand (`activeTab` + `scripting`), so there's no
  always-on page access.
- **Page reading.** `readPage()` extracts the visible article/code/chat text,
  stripping nav and chrome; `detectMode()` tags the page (code / research /
  writing / …) so Roody acts like the right kind of expert.
- **Screenshots.** The background captures the visible tab with
  `chrome.tabs.captureVisibleTab` and attaches the image to the model request
  (Gemini `inlineData` / Claude image block). Only ever for a message you send.
- **Brains.** With an invite code, requests ride the founder's credits proxy
  (Gemini); with your own key, they go straight to the provider.

## Files

| File | What it is |
|------|------------|
| `manifest.json` | Extension manifest (MV3) |
| `src/persona.js` | Roody's personality (the coding-assistant system prompt) |
| `src/background.js` | Calls the model, captures screenshots, routes brains |
| `src/content.js` | The orb, the chat panel, Markdown rendering, page reading |
| `src/content.css` | Roody's transparent glass look |
| `src/study.html/js` | Standalone "Read with Roody" tab for PDFs |
| `src/options.html/js` | Settings — invite code, language, keys (dev panel) |

## Notes

- Keys and your invite code are stored locally (`chrome.storage.local`) and only
  sent to the AI provider you chose. See [PRIVACY.md](PRIVACY.md).
- Run the regression suite with `node eval/run.js`.
