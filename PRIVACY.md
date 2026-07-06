# Roody Privacy Policy

*Last updated: July 2026*

Roody is a browser extension that acts as an on-demand AI voice companion.
This policy explains exactly what data Roody touches and where it goes.

## The short version

- Roody loads **nothing** until you click its icon on a page.
- Roody **refuses to run** on personal pages: banking, payments, email,
  messaging, social media, government sites, and any page containing
  password or payment-card fields.
- Your **conversations are never stored** — not by us, not anywhere.
- With your **own API key**, everything goes directly from your browser to
  the AI provider — we're not in the middle at all.
- With an **invite code**, requests pass through our small relay server,
  which counts usage (calls, tokens) to enforce daily limits — it does
  **not** store the content of your pages or messages.
- Creating a **portal account** is optional; if you do, we store only your
  email, display name, and invite code.

## What Roody reads

When — and only when — you summon Roody on a page, it reads the visible text
of that page so the AI can discuss it with you. If you use voice, your
microphone audio is transcribed by your browser's built-in speech
recognition.

## Where data goes

Your messages and short page excerpts are sent directly from your browser to
the AI service **you** selected in settings, using **your** API key:

- Google Gemini (generativelanguage.googleapis.com)
- Anthropic Claude (api.anthropic.com)
- xAI Grok (api.x.ai)
- ElevenLabs voice (api.elevenlabs.io)

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
- Your preferences (voice, language, character)
- Roody's "notebook" — short snippets of pages where you talked to Roody,
  so it can connect context across tabs
- A usage/cost counter

You can view and erase the notebook and all settings at any time from the
extension's Settings page. Uninstalling the extension deletes everything.

## What Roody never does

- Never loads or reads pages in the background
- Never runs on blocked personal-site categories, even if summoned
- Never edits, clicks, types, or changes anything on any page
- Never sells, shares, or transmits data to anyone besides the AI provider
  you chose

## Contact

Questions: open an issue at https://github.com/F1VISABYARUN/Roody-ai
