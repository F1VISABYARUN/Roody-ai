# Chrome Web Store Submission — copy-paste pack

Everything you need for the developer console (chrome.google.com/webstore/devconsole).
Fee: one-time $5 for the developer account.

## Name
Roody — AI coding assistant

## Summary (132 chars max)
Summon an AI coding assistant on any page. It reads the page and your screen, answers questions, and writes code in the chat.

## Description
Roody is an AI coding assistant that lives on the page you're already on — not
another chatbot tab you have to copy-paste into.

Click the Roody icon to summon a glass orb on any work page: code on GitHub or
Stack Overflow, documentation, an editor, an article, a PDF. Roody reads what's
on your screen and you ask it anything — what's wrong with this code, how to fix
this error, write me a function. It answers right there in the chat, in clean
Markdown with copy-able code blocks.

WHAT MAKES ROODY DIFFERENT
• Reads your screen: the code and text on the page, and — on request — a
  screenshot, so it can see diagrams, rendered UIs, and error dialogs
• Writes code: real, runnable answers in formatted blocks, not just descriptions
• Transparent glass UI that floats over your work, draggable anywhere
• Pick your brain: Gemini by default, Claude or Grok with your own key
• Answers in your language: English, Telugu, Hindi, Tamil, and more

PRIVACY BY DESIGN
• Loads NOTHING until you click the icon — no background reading, ever
• Screenshots are captured only for a message you send, never in the background
• Refuses to work on personal pages: banking, payments, email, chats, social
  media, government sites — plus any page with password or card fields
• You bring your own AI key (Google Gemini works free), or an invite code; page
  text and screenshots go only to the AI provider you chose

READ-ONLY, ALWAYS
Roody never edits, types, clicks, or changes anything on any page. It reads and
it answers, that's it.

SETUP (2 minutes)
1. Install → click the Roody icon on any work page
2. Open Settings → paste your invite code, or a free Gemini API key
   (aistudio.google.com/apikey)
3. Ask Roody about the code or the page

## Category
Developer Tools

## Language
English

## Single purpose statement (for the review form)
Roody is an on-demand AI coding assistant: when the user clicks the extension
icon, it reads the current page's visible text (and, only for a message the user
sends, a screenshot of the tab) and lets the user ask questions and get code from
an AI model in a chat panel. It performs no other function.

## Permission justifications (for the review form)
- activeTab: to read the visible text of the page — and, only when the user
  sends a message asking about the screen, to capture a screenshot of the active
  tab — ONLY after the user explicitly clicks the extension icon.
- scripting: to inject the assistant UI (orb + chat panel) into the active tab
  when — and only when — the user clicks the icon.
- storage: to save the user's own API keys, invite code, preferences, and local
  conversation memory on their device.
- Host permissions (api.anthropic.com, generativelanguage.googleapis.com,
  api.x.ai, plus the credits proxy): to send the user's messages, page excerpts,
  and any attached screenshot to the AI provider the USER selected. No data is
  sent anywhere else.

## Data usage disclosures (check these boxes)
- Does NOT collect user data (for the AI analysis, data goes only from the
  user's browser to the AI provider the user configured; the optional invite-code
  proxy keeps usage counts only, never content)
- Remote code: none (all code is packaged in the extension)

## Privacy policy URL
Host PRIVACY.md publicly (e.g. GitHub) and paste the raw link, e.g.:
https://github.com/F1VISABYARUN/Roody-ai/blob/main/PRIVACY.md

## Screenshots needed (1280x800, min 1)
1. Roody orb + panel open on a code page, showing an answer with a code block
2. Roody answering about a screenshot (a diagram or rendered UI)
3. The refusal toast on a banking-looking page ("Roody stays out of personal
   pages") — this one makes the privacy story land with reviewers

## Review-time gotchas
- Reviewer may ask why you need several API hosts: answer = user-selectable AI
  provider, user's own key, see justifications above.
- Be clear that screenshots are captured only for a message the user sends
  (captureVisibleTab under activeTab), never in the background.
