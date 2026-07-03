# Chrome Web Store Submission — copy-paste pack

Everything you need for the developer console (chrome.google.com/webstore/devconsole).
Fee: one-time $5 for the developer account.

## Name
Roody — your AI voice companion

## Summary (132 chars max)
Summon an AI best friend on any task page. It reads along, talks with you by voice, and never touches personal pages.

## Description
Roody is an AI companion that keeps you company while you work — not another
chatbot tab, a friend on the page you're already on.

Click the Roody icon to summon the orb on any task page: an article you're
reading, documentation, a coding site, an AI chat, a course, a recipe. Roody
reads along and you can talk to it — real voice, both ways. Ask what a page
means, get a second opinion, brainstorm when you're stuck, or just chat while
you grind.

WHAT MAKES ROODY DIFFERENT
• Voice-first: talk naturally, hear replies in a warm human voice
• A friend, not a bot: jokes, honest opinions, encouragement — a personality
• Character sidekicks: a Minion, Tom & Jerry, and more can jump in
• Speaks your language: English, Telugu, Hindi, Tamil, and 10+ more
• Remembers context: connects what you're doing across pages (stored only on
  your device)

PRIVACY BY DESIGN
• Loads NOTHING until you click the icon — no background reading, ever
• Refuses to work on personal pages: banking, payments, email, chats, social
  media, government sites — plus any page with password or card fields
• You bring your own AI keys (Google Gemini works free); page text goes only
  to the AI provider you chose
• We run no servers and collect nothing — settings and memory stay in your
  browser

READ-ONLY, ALWAYS
Roody never edits, types, clicks, or changes anything on any page. It reads,
it talks, that's it.

SETUP (2 minutes)
1. Install → click the Roody icon on any task page
2. Open Settings → paste a free Gemini API key (aistudio.google.com/apikey)
3. Tap the orb and start talking

## Category
Productivity

## Language
English

## Single purpose statement (for the review form)
Roody is an on-demand AI voice companion: when the user clicks the extension
icon, it reads the current page's visible text and lets the user discuss it
with an AI model by voice or text. It performs no other function.

## Permission justifications (for the review form)
- activeTab: to read the visible text of the page ONLY after the user
  explicitly clicks the extension icon, so the AI can discuss that page.
- scripting: to inject the companion UI (orb + chat panel) into the active
  tab when — and only when — the user clicks the icon.
- storage: to save the user's own API keys, preferences, and local
  conversation memory on their device.
- Host permissions (api.anthropic.com, generativelanguage.googleapis.com,
  api.elevenlabs.io, api.x.ai): to send the user's messages and page excerpts
  to the AI/voice provider the USER selected with THEIR OWN API key. No data
  is sent anywhere else.

## Data usage disclosures (check these boxes)
- Does NOT collect user data (we run no servers; data goes only from the
  user's browser to the AI provider the user configured)
- Remote code: none (all code is packaged in the extension)

## Privacy policy URL
Host PRIVACY.md publicly (e.g. GitHub) and paste the raw link, e.g.:
https://github.com/F1VISABYARUN/Roody-ai/blob/main/PRIVACY.md

## Screenshots needed (1280x800, min 1)
1. Roody orb + panel open on a documentation/article page, mid-conversation
2. Settings page showing language + sidekick options
3. The refusal toast on a banking-looking page ("Roody stays out of personal
   pages") — this one makes the privacy story land with reviewers

## Review-time gotchas
- Reviewer may ask why you need 4 API hosts: answer = user-selectable AI
  provider, user's own key, see justifications above.
- Keep the store description honest about voice: browser speech recognition
  is used for the mic; audio replies come from the AI voice provider.
