# Roody ✦ Companion

**Chrome hackathon demo 3.2.0:** live voice and settings inside one orb.

[Download the Chrome extension ZIP](https://github.com/F1VISABYARUN/Roody-ai/raw/refs/heads/codex/roody-desktop-demo-settings/Roody-Companion-3.2.0-Chrome.zip). Extract it before loading in Chrome.
The main view has **Talk**, **See my screen**, and text chat. Personas, language,
modes, goals, and tasks are under **More**. No npm command is needed to use
Chrome's **Load unpacked**; select the folder containing `manifest.json`,
reload the extension, and refresh the webpage after updating source files.

Voice runs in a protected offscreen extension document so closing the panel
or navigating browser pages can leave the conversation running. **Pause voice**
stops the microphone and sharing. A screen selected through one page stops
being shared when that source page navigates; select it again in the new orb.
Browser following is optional and requires website access. It samples page
text about every five seconds; changed screen images about every twelve.
Spoken check-ins wait while either participant speaks and use a cooldown.

For guest demos, deploy the Vercel backend using [the setup guide](server/VERCEL-DEMO.md).
The owner key stays in server environment variables. Guests enter the Vercel
address and a code in Settings. Each code has 100 total app credits: 1 for text
or 30 for up to three minutes of voice. Balances live in Redis; these units
are separate from OpenAI billing. The code-generation admin page is
`/demo-admin.html`. This backend has not been deployed by these file updates.

Own-key access remains under **Use my own OpenAI key instead** in Settings.
Clear the demo server address to switch back. Never embed an owner key in a
shared extension ZIP. See [Windows steps](START-HERE-WINDOWS.txt) for usage.

The orb lives inside Chrome. Screen sharing lets it discuss visible native
editor windows; it cannot read files from disk or edit/click for the user.

The Windows desktop companion hackathon prototype is in [`desktop/`](desktop/README.md).
It includes a floating orb, voice connection, selected-window analysis, local
goals/tasks, and three labeled persona demo scenarios. See its README for setup
and current limitations. The browser extension below remains available.

**A transparent, read-only companion for learning, coding, and planning.**

Roody is a Chrome extension that puts a glass orb on top of whatever you're
working on. It reads what's on your screen — the code and text on the page, and,
when you ask, a **screenshot** of the actual screen — then answers your questions
and **writes code drafts** in the chat. Live conversation is available in the
orb; text replies use Markdown and runnable code blocks.

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

- **Click-to-summon.** Normal use injects the content script on a toolbar click
  (`activeTab` + `scripting`). Optional **Follow browser** requests website access
  and injects the orb on active pages while following is enabled. It starts off
  and stops when voice is paused or closed.
- **Page reading.** `readPage()` extracts the visible article/code/chat text,
  stripping nav and chrome; `detectMode()` tags the page (code / research /
  writing / …) so Roody acts like the right kind of expert.
- **Screenshots.** The background captures the visible tab with
  `chrome.tabs.captureVisibleTab` and attaches the image to the model request
  (Gemini `inlineData` / Claude image block) for a message you send. Optional voice
  screen sharing separately sends changed frames through OpenAI Realtime.
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
