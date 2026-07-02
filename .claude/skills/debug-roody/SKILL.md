---
name: debug-roody
description: Diagnose Roody problems (robotic voice, mic not hearing, high cost, silent orb) from the roodyLog the user pastes from Settings.
---

# Debug Roody from Its Log

The user copies the log from Settings → Logs → 📋 Copy. Every diagnosis starts there. Ask for it if you don't have it.

## Reading the log

| Line | Meaning |
|------|---------|
| `TTS request: eleven=yes gemini=no` | Which TTS keys exist. `eleven=yes` → ElevenLabs is tried first |
| `🔈 ROBOTIC voice (...)` | Fell back to browser TTS — the reason is in the parentheses |
| `❌ ElevenLabs 401` | Bad/rotated key |
| `❌ ElevenLabs 402 paid_plan_required` | Free tier can't use that library voice via API → Settings → "Load voices my key can use" |
| `❌ ElevenLabs 429` | Free credits (10k/month) exhausted → falls back to Gemini TTS |
| `⚠ AudioContext failed` | Playback blocked (CSP/autoplay) — rare since the AudioContext path |
| `💾 cache HIT n` | Prompt caching working (90% off those tokens). Missing on turn 2+ = system prompt not byte-stable |
| `🎤 SR ended (no transcript...)` | Chrome's speech backend returned nothing — normal occasionally; constant = mic/permission issue |
| `…ignored as ECHO` | Echo filter caught Roody hearing itself — working as designed |
| `…ignored (Roody is speaking, not an interrupt word)` | Barge-in filter — only stop/wait/etc. interrupt mid-speech |
| `⏱ brain timed out` | Service worker asleep or network dead — refresh the tab |
| `msgs=21 +web` with `in=4000+` | Expensive text-mode call: full history + web search |

## Common complaints → first checks

**"Robotic voice"** — trace the TTS chain in the log: keys present? → which provider tried? → what error? The answer is always in a `🔈` or `❌` line.

**"Not listening to me"** — look for `🎤 HEARD:` lines. Present but no reply → check brain errors. Absent → mic permission, wrong `roodyLang` vs spoken language, or Roody was speaking (barge-in filter).

**"Too expensive"** — check for `💾 cache HIT` (should appear from turn 2), `+web` calls (web search in text mode is the priciest path), and whether voice turns show `claude-sonnet` instead of `claude-haiku` (cheap voice brain OFF).

**"Orb missing / silent on a site"** — site must be in `manifest.json` content_scripts matches; user must refresh the tab after (re)loading the extension.

## Architecture in one breath

`content.js` (orb UI, SpeechRecognition mic, AudioContext playback, page reading, notebook) → messages → `background.js` (brain routing Claude/Gemini/Grok, ElevenLabs/Gemini TTS, cost meter, log) → `persona.js` (system prompt + sidekick overlays). Settings live in `chrome.storage.local`; `options.js` reads/writes them and most changes are picked up live via `storage.onChanged`.
