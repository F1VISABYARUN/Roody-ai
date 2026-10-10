# Roody ✦ Companion

**An AI companion that sits on top of whatever you're working on — and helps you learn, code, and plan.**

Roody is a Chrome extension. Click its icon on any page and a glass orb appears.
Open the orb and Roody can read the page you're on, look at your screen when you
ask, and help you right there — in English or తెలుగు — without you copying
anything into a separate chatbot tab.

> **Status:** hackathon demo, version 3.0.0. Built for the OpenAI DevDay community
> hackathon in Bengaluru (October 10, 2026). Working prototype, not a finished
> product.

---

## What Roody does

- **Reads the page with you.** Code on GitHub or Stack Overflow, documentation,
  articles, PDFs, and online code editors (it reads Monaco, CodeMirror, and Ace
  editors line by line, so it sees your real code, not a jumbled copy).
- **Looks at your screen.** Click **Look at this** and Roody takes one screenshot
  of the tab, so it can understand diagrams, error dialogs, and rendered pages.
  It hides its own orb and panel first, so it never mistakes itself for your
  page. It also attaches a screenshot automatically when you ask something like
  *"what's wrong with my code?"* on a coding page.
- **Adapts to who you are.** Pick a persona — **Developer**, **Grandparent**, or
  **Founder** — and Roody changes how it talks and what it focuses on.
- **Helps the way you want.** Choose **Teach me**, **Do with me**, or **Do for me**
  (see below).
- **Remembers your goal.** Save a goal and a short task list in the panel
  (To do / Doing / Done / Blocked). Roody keeps them in mind in every answer.
- **Talks out loud.** A separate **live voice** window lets you have a spoken
  conversation in English or Telugu, powered by OpenAI's Realtime voice.
- **Answers in your language.** English and Telugu in the panel (switch freely
  between them); more reply languages in Settings.
- **Writes real code.** Answers come in clean Markdown with code blocks and a
  one-click **Copy** button.

## Personas and modes

| Persona | How Roody helps |
|---|---|
| **Developer** | A coding companion: reasons about code, errors, and architecture, and gives practical, runnable suggestions. |
| **Grandparent** | A patient everyday companion: simple language, explains unfamiliar buttons and forms, one step at a time. |
| **Founder** | A CEO/CTO-style adviser: clarifies the goal, weighs trade-offs, and turns it into concrete next steps. |

| Mode | What it means |
|---|---|
| **Teach me** | Roody explains the reasoning in small steps and asks you a question to check you understood. |
| **Do with me** | Roody works through it with you and suggests the next step. *(Default.)* |
| **Do for me** | Roody prepares a draft — code, a plan, or an analysis — for **you** to review. |

**Roody never acts on your behalf.** In every mode it only reads and suggests.
It does not click, type, edit files, send messages, book, or pay.

**Try a sample** loads a clearly labeled practice scenario for the selected
persona (a login bug, a booking page, onboarding numbers), so you can see Roody
work without sharing anything real.

## Install (Chrome)

No coding or terminal needed.

1. Download **`Roody-Companion-3.0.0-Chrome.zip`** from this repository and extract it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the extracted folder (the one with `manifest.json` inside).
5. If you had an older Roody installed, turn it off, then refresh the page you're on.

**Summon Roody:** click the Roody icon in the toolbar, or press **Alt + R**.

## Connect a brain

Open the orb and click the **⚙ Settings** gear.

- **OpenAI key** (top of Settings) — paste your key from
  [platform.openai.com](https://platform.openai.com/api-keys) and click **Save key**.
  This powers chat, screenshots, and live voice. Voice needs an OpenAI API
  account with Realtime access and billing turned on.
- **Invite code** — free daily text chat on Roody's own model. No key needed.
- **Your own Claude, Gemini, or Grok key** — also supported. The
  **Preferred brain** buttons choose which one answers; **Auto** uses whichever
  key you've added.

You never type a model name. Roody asks each provider which models your key can
use and picks the newest one automatically.

> ChatGPT Plus doesn't include API access. The API is billed separately on
> platform.openai.com.

## Live voice

1. In the orb panel, click **◉ Voice**. A separate Roody voice window opens.
2. Click **Start conversation** and allow the microphone.
3. Talk in English, Telugu, or a mix of both. You can interrupt Roody by talking.

The voice window gets a one-time text snapshot of your page plus your goal and
tasks. It does **not** see screenshots or watch your screen live, and it can't
change your task board. Pause or close the window to stop the microphone.

## Privacy and safety

- **Nothing runs until you click.** Roody loads only on the page where you
  summon it.
- **Stays out of personal pages.** It refuses to run on banking, payment, email,
  chat, social media, and government sites, and on any page with a password or
  card-number field.
- **Read-only.** It never clicks, types, or changes anything on a page.
- **Your data stays local.** API keys, goals, tasks, and settings are stored in
  your browser. Full conversations, screenshots, and voice audio are not saved
  by Roody.
- **Your key, your provider.** With your own key, requests go straight from your
  browser to that provider. With an invite code, requests go through Roody's
  small server, which counts usage but doesn't store your messages.

Full details: [PRIVACY.md](PRIVACY.md).

## Desktop app (Windows prototype)

The [`desktop/`](desktop/README.md) folder has a separate **Windows app**: a
floating orb that stays on top of any app (not just Chrome), with voice,
screenshots of a window you choose, goals and tasks, the same three personas,
and optional spoken check-ins when the window you're following changes. It
needs Node.js 22+ to run — see [desktop/README.md](desktop/README.md) for setup
and its current limits.

## Current limits (honest list)

- It's a hackathon prototype.
- **Do for me** produces drafts only. It never performs actions.
- Live voice needs an OpenAI API key with Realtime access, and it costs API credits.
- Goals and tasks are saved per browser. The Chrome extension and the desktop
  app don't sync with each other.
- Personal and login pages are blocked on purpose, so Roody won't open on them.

## How it works (for developers)

```
You click the orb on a page
        │
        ▼
content script ── reads page text / code editors, takes a screenshot if needed,
        │         shows the panel, goals, and tasks
        ▼
background worker ── adds persona + mode + goal/tasks, picks the brain,
        │            calls the provider, retries if it's busy
        ▼
OpenAI / Claude / Gemini / Grok ── answer comes back as Markdown in the panel

Voice: voice window ── short-lived credential from the background worker ──▶ OpenAI Realtime
```

- **Click-to-summon.** The extension uses `activeTab` + `scripting` and injects
  only when you click, so it has no always-on access to your pages.
- **Companion memory** (persona, mode, language, goal, tasks) lives in
  `chrome.storage.local` and is added to every request as data, not instructions.
- **Voice credentials.** The voice window gets a short-lived Realtime token from
  the background worker. The voice window never sees your real API key.

### Project layout

| Path | What it is |
|---|---|
| `manifest.json` | Chrome extension manifest (Manifest V3) |
| `src/content.js` · `src/content.css` | The orb, panel, chat, goals/tasks board, page and editor reading |
| `src/background.js` | Picks the brain, calls providers, takes screenshots, starts voice |
| `src/companion.js` | Personas, modes, languages, and the goals/tasks memory |
| `src/persona.js` | Roody's core personality and safety rules |
| `src/models.js` | Finds the newest model each provider offers |
| `src/voice.html` · `voice.js` · `voice.css` | The live voice window |
| `src/options.html` · `options.js` | Settings: keys, invite code, language, transparency |
| `src/study.html` · `study.js` · `pdf.js` | "Read with Roody" tab for PDFs |
| `src/sanitize.js` | Cleans up model replies |
| `desktop/` | Windows desktop app (Electron) |
| `server/` | Small Node.js server for invite codes and free daily usage |
| `backend/` · `backend-php/` | Alternative versions of that server (Supabase, PHP) |
| `editor/` | Older VS Code companion (separate project) |
| `site/` | Public website, privacy page, and user portal |
| `eval/` | Automated checks |

### Run the checks

```bash
node eval/run.js                   # main regression suite
node --test eval/*.test.js         # companion and background tests
cd desktop && npm ci && npm test   # desktop app tests
```

## Roody's journey

- **v1 — Voice companion.** A friendly orb that read along with you and talked out loud.
- **v2 — AI coding assistant.** Text-first, glass UI, real code-editor reading,
  screenshot vision, and multiple AI providers.
- **v3 — Companion (now).** Personas, Teach / With / For modes, goals and tasks,
  live voice in English and Telugu, and a desktop app.
