# Roody for Editors — Antigravity, VS Code, Cursor

The Roody orb in your editor sidebar. It sees your open file, hears your voice,
and talks back out loud. Same brain, persona, and sidekicks as the browser
extension.

## How it works

```
you speak → panel records your mic → Gemini transcribes it
         → brain (Claude/Gemini/Grok) reads your open file + your words
         → reply plays out loud (ElevenLabs or Gemini voice)
         → mic turns back on. Loop.
```

Tap the orb = voice on/off. Tap while Roody talks = shut him up.
Typing in the box always works too.

## Install in Antigravity (or VS Code / Cursor)

### Option A — Install from folder (fastest for the demo)

1. Get this repo on your machine and note the path to the `editor/` folder
2. In Antigravity: `Ctrl+Shift+P` → **"Developer: Install Extension from Location…"**
3. Pick the `editor/` folder
4. Reload the window (`Ctrl+Shift+P` → "Reload Window")
5. The Roody orb icon appears in the left activity bar

### Option B — Package a .vsix (for sharing)

```bash
cd editor
npx @vscode/vsce package --no-dependencies
```

Then in Antigravity: Extensions panel → `…` menu → **Install from VSIX** →
pick the generated `roody-editor-0.1.0.vsix`.

## Set your keys (one time)

`Ctrl+,` (Settings) → search "roody" → paste:

| Setting | What | Required? |
|---------|------|-----------|
| `roody.geminiKey` | Gemini API key — powers the EARS (transcription) + backup voice + optional brain. Free at aistudio.google.com/apikey | **YES — voice needs this** |
| `roody.anthropicKey` | Claude brain | If using a claude-* model |
| `roody.elevenKey` | ElevenLabs premium voice | Optional |
| `roody.model` | Brain choice (default: claude-haiku-4-5) | — |
| `roody.vibe` | Character sidekick (minion, tom, jerry…) | — |
| `roody.language` | Reply language (te-IN for Telugu, hi-IN for Hindi…) | — |

## Use it

1. Click the Roody orb in the activity bar → panel opens
2. **Tap the orb** → it pulses green → speak: *"what do you think of this file?"*
3. Stop talking → Roody transcribes, thinks, and TALKS BACK
4. Mic re-opens automatically after Roody finishes — it's a conversation
5. Tap the orb mid-speech to cut him off

Roody sees: your active file, your selection, and the current errors/warnings.
Ask things like *"why is this test failing?"*, *"roast my code"*, *"I'm stuck,
throw me ideas"*.

## Troubleshooting

- **"can't reach the mic"** — the editor needs OS-level microphone permission
  (macOS: System Settings → Privacy → Microphone → enable your editor).
- **Replies are text-only, no voice** — no TTS key set. Add `roody.geminiKey`
  (or `roody.elevenKey`).
- **"didn't catch that"** — speak a bit louder/longer; the recorder needs ~1s
  of clear speech before 1.5s of silence to trigger.
