# Roody Privacy Policy

*Last updated: October 10, 2026*

Roody is a browser extension that acts as an on-demand AI companion.
This policy explains exactly what data Roody touches and where it goes.

## The short version

- Roody loads **nothing** until you click its icon on a page.
- Roody **refuses to run** on personal pages: banking, payments, email,
  messaging, social media, government sites, and any page containing
  password or payment-card fields.
- Full conversations, screenshots, and voice audio are not saved by the
  extension. Short notebook snippets/summaries, goals, and tasks are saved
  locally. Provider data handling depends on your API account's settings.
- With your **own API key**, everything goes directly from your browser to
  the AI provider — we're not in the middle at all.
- With an **invite code**, requests pass through our small relay server,
  which counts usage (calls, tokens) to enforce daily limits — it does
  **not** store the content of your pages, messages, or screenshots.
- Creating a **portal account** is optional; if you do, we store only your
  email, display name, and invite code.

## What Roody reads

When — and only when — you summon Roody on a page, it reads the visible text
of that page so the AI can help you with it. If you ask about something
visual (or tap the 📷 button), Roody captures a screenshot of the current
tab and sends that image with your message so the AI can see what you see.
Screenshots are taken only for a message you send or when you click **Look at
this**, and are never captured in the background.

## Optional live voice

Clicking **Voice** opens a Roody extension-owned window and shares a one-time
text snapshot from the current page. Microphone access begins only after you
click **Start conversation** and approve Chrome's permission request. While
connected, audio is streamed to OpenAI's Realtime service for conversation and
transcription. Pause or close the window to stop the microphone. The voice
window receives an ephemeral credential; your full API key stays in extension
storage and the background worker. It does not continuously watch your screen.
Voice transcripts stay in the window for that session and are not saved by Roody.

## Where data goes

Your messages, short page excerpts, and any screenshot you attach are sent
directly from your browser to the AI service **you** selected in settings,
using **your** API key:

- Google Gemini (generativelanguage.googleapis.com)
- Anthropic Claude (api.anthropic.com)
- xAI Grok (api.x.ai)
- OpenAI (api.openai.com), including optional Realtime voice

Their handling of that data is governed by their own privacy policies.

**If you use your own API key,** Roody adds no middleman — requests go
straight from your browser to the provider above.

**If you use an invite code,** requests are relayed through our server so we
can apply your code's daily limit. The relay forwards your request to the AI
provider and passes the reply back. It keeps **usage metadata only** — call
counts, token counts, and estimated cost per code. It never stores or logs
the content of your messages, your pages, or your audio.

## Optional portal account & waitlist

You can use Roody with just an invite code and no account. If you choose to
create a portal account (to see your usage at a glance), we store: your
**email address**, an optional **display name**, your **invite code**, and
hashed login tokens. If you join the waitlist, we store your email and
optional name until we send you a code. We never sell or share these, and
you can ask us to delete them at any time via the contact below.

## What stays on your device

Stored only in your browser's local extension storage:

- Your API keys
- Your preferences (reply language, settings)
- Your current goal, task titles/statuses/blockers, persona, and assistance mode
- Roody's "notebook" — short snippets of pages where you talked to Roody,
  so it can connect context across tabs
- A usage/cost counter

API keys are stored in Chrome's local extension storage; this is separate from
the desktop app's OS-encrypted key storage. Key-entry fields exist only on the
extension-owned Settings page, never inside the webpage's orb panel. You can
remove keys in Settings, clear the notebook there, and edit tasks in the orb.
Uninstalling the extension deletes its local data.

## What Roody never does

- Never loads or reads pages in the background
- Never runs on blocked personal-site categories, even if summoned
- Never edits, clicks, types, or changes anything on any page
- Never sells, shares, or transmits data to anyone besides the AI provider
  you chose

## Contact

Questions: open an issue at https://github.com/F1VISABYARUN/Roody-ai
