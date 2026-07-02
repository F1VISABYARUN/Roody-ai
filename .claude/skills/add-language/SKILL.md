---
name: add-language
description: Add a new spoken language to Roody (mic recognition + brain replies). Two places must stay in sync or the brain gets a code it can't read.
---

# Add a Language to Roody

Roody's language flows through two systems that must agree:
- **SpeechRecognition** (mic) uses a BCP-47 code like `te-IN`
- **The brains** (Claude/Gemini/Grok) need the language **name** ("Telugu") — sending the raw code produces English replies (this was a real bug)

## 1. Settings dropdown — `src/options.html`

Add to `<select id="lang">` using a valid BCP-47 code Chrome's speech backend supports:

```html
<option value="bn-IN">বাংলা Bengali (India)</option>
```

## 2. Language-name map — `src/background.js`

Add the short code → English name to `LANG_NAMES`:

```js
"bn": "Bengali",
```

If the short code is missing here, `langName()` returns null and the brain gets NO language instruction → replies in English even though the mic understood the user.

## Verify

- Settings → pick the language (auto-saves on change)
- Voice ON → speak in that language → log shows `🎤 HEARD:` with correct words
- Roody replies in that language (check the bubble text)

## Notes

- TTS: Gemini TTS speaks most major languages with the same voice. ElevenLabs `eleven_turbo_v2_5` supports ~32 languages — very rare languages may sound off.
- The `en-*` variants intentionally get no language instruction (English is the default).
