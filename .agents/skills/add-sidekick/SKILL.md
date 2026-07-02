---
name: add-sidekick
description: Add a new character sidekick to Roody (e.g. Shrek, Pikachu). Touches persona, settings UI, preview text, and TTS voice styling — all five places that must stay in sync.
---

# Add a Character Sidekick to Roody

A sidekick is a character that interrupts Roody every 2-3 replies with signature chaos. Adding one means updating **five places** — miss one and the character will half-work (text but no voice styling, or a dropdown option with no behavior).

Use a short lowercase key with no spaces (e.g. `shrek`) consistently in all five places.

## 1. Personality overlay — `src/persona.js`

Add a new key to `self.ROODY_VIBES`:

```js
shrek: `
CHARACTER SIDEKICK: SHREK 🧅
You are still Roody. But Shrek barges in every 2-3 replies.
HOW IT WORKS:
- Most replies: normal Roody.
- Every 2-3 replies: Shrek interrupts.
WHEN SHREK APPEARS:
- Catchphrases, speech quirks, signature behaviors (3-6 bullet points)
- Action narration in *asterisks*: *slams door*, *eats onion*
- After the moment, Roody takes back over: "OK, anyway..."`,
```

Follow the existing entries' shape: interruption pattern, catchphrases, action narration, hand-back line. Keep it 10-20 lines.

## 2. Settings dropdown — `src/options.html`

Add an `<option>` to `<select id="vibe">`:

```html
<option value="shrek">🧅 Shrek — grumpy ogre, everything is a swamp</option>
```

## 3. Preview line — `src/options.js`

Add to `VIBE_PREVIEWS` (shown live when the user selects the character):

```js
shrek: "Roody: \"That function looks—\" Shrek: \"WHAT are ye doing in my SWAMP— I mean, my codebase?!\"",
```

## 4. Gemini TTS voice styling — `src/background.js`

Add to `SIDEKICK_TTS_STYLES` — an acting direction so the TTS voice actually sounds different during character moments:

```js
shrek: "Perform this with a gruff, grumpy, Scottish-accented ogre voice. Slow and growly on complaints, warm underneath",
```

## 5. ElevenLabs voice settings — `src/background.js`

Add to `SIDEKICK_ELEVEN_SETTINGS`. Rules of thumb: chaotic characters get low stability + high style (Minion: 0.2/0.9); smooth characters get high stability + moderate style (Pink Panther: 0.6/0.5):

```js
shrek: { stability: 0.35, similarity_boost: 0.7, style: 0.7, use_speaker_boost: true },
```

## Verify

Grep the new key across all files — it must appear in exactly these five places:

```
grep -rn "shrek" src/
```

Expected: persona.js (1), options.html (1), options.js (1), background.js (2).

## Legal note

Do NOT clone copyrighted character voices via ElevenLabs voice cloning. Style-prompting a generic voice to be "gruff and ogre-like" is fine; replicating a specific actor's voice is not.
