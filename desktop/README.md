# Roody desktop hackathon demo

A separate Electron app for Windows: a floating, draggable, always-on-top orb;
English/Telugu conversation; selected-window screenshots; teach/collaborate/draft
modes; local goals and tasks; background context investigations; and spoken
check-ins. The existing browser and editor extensions remain independent.

## Run on Windows

Install Node.js 22+ and open PowerShell at the repository root:

```powershell
cd desktop
npm ci
npm start
```

Click the orb, open **⚙ Settings**, paste your OpenAI API key in its password
field, and click **Save key**. It takes effect immediately; no restart or terminal
environment variable is required. Settings opens automatically on first launch
when no key is configured. Do not paste the key into Roody's conversation.

**Remember on this computer** encrypts the key with Electron's OS-backed
`safeStorage` (Windows DPAPI). If protected storage is unavailable, only session
storage is offered; the key disappears when the app exits. Settings shows whether
a key is configured without retrieving or displaying it. **Remove key** deletes
the local key and stops the current voice session. Keys are stored separately
from task memory and are never included in chat/history. Saving checks key format
only, not billing or provider access; try a normal conversation to verify access.

The password field is cleared after saving. The renderer passes the entered key
to Electron's main process through the isolated preload bridge; provider requests
and saved-key decryption happen in the main process. The renderer receives
a short-lived Realtime credential for its WebRTC session. Default models are
`gpt-4o` for text/images and `gpt-realtime` for voice; override with `ROODY_MODEL`
and `ROODY_REALTIME_MODEL` if your account requires different public model IDs.
No Dots API, external app connector, or undocumented model ID is used.

`OPENAI_API_KEY` from the launch environment still works as an optional fallback;
a key entered in Settings takes priority. Removing the local key falls back to
that environment key if present. The Chrome extension keeps its own separate
Options/key settings; these desktop settings do not sync with Chrome.

Open the orb, choose a persona and assistance mode, save a goal, then type or
click **Start voice**. Voice requires microphone permission, network/API access,
and billing. You can interrupt by speaking, or click **Pause / interrupt** to
stop voice and automatic following. Text remains available when voice fails.

**Look at this** opens a window picker. Choose a window, then ask Roody to analyze
it. This shares a snapshot with OpenAI when you send your next request. Selecting
a window does not itself send its screenshot to a model. No full-screen source
is offered. Clear removes the current screenshot and ends following.

On Windows, optionally enable **Follow this window**. While the selected window
is in the foreground, a title/page change triggers a fresh screenshot and a
spoken check-in, with a one-minute cooldown. This depends on Windows window
titles: it does not detect every search, page change, or app transition. It
follows only the selected window. Following starts off; permission must be
enabled each time the app launches. The app does not read browser DOM or URLs.

When Realtime voice is connected, spoken check-ins use that session; otherwise
they use installed Windows speech voices. Telugu speech in that fallback depends
on installed Windows language/voice packs.

## Three-persona demo (no external integrations)

1. **Grandparent → Teach me → Load demo scenario.** Send the labeled sample
   booking-page description. Roody explains the form and the sponsored ad.
   Alternatively share a real non-sensitive booking page with Look at this.
2. **Developer → Do with me → Load demo scenario.** Save the login goal, send
   the sample 401 context, add a task, then click Investigate context. This runs
   a separate model request in the background while chat remains usable. It
   analyzes only supplied context; it does not access a repository or fix files.
3. **Founder → Do for me → Load demo scenario.** Send the explicitly labeled
   sample onboarding metrics and feedback. Roody recommends a priority and
   explains why. These are sample data, not Gmail/analytics connections.
4. Enable Follow for a selected browser window and change pages to demonstrate
   spoken context check-ins; or use Check in in 5m for a timed goal reminder.

The demo scenarios are local text fixtures and still call the actual model for
answers. There are no canned AI responses or pretend tool integrations.

## Memory, scope and limitations

Goals, tasks, blockers, preferences, and task completion persist in `memory.json`
under Electron's Windows user-data directory (normally `%APPDATA%/Roody` or
`%APPDATA%/roody-desktop`, depending on packaging). Screenshots and conversation
history are not saved by the app. They are transmitted to OpenAI when requested
and are subject to the API account's data settings. Desktop task memory does not
sync with the existing extensions or their accounts.

Voice conversation receives a copy of the task board and preferences; changing
tasks uses the UI. Voice alone does not automatically save goals or execute tools.
Timed reminders last only while Roody runs. Investigations return drafts/findings,
not computer actions. No clicking, file editing, sending, payment, booking,
Gmail/Calendar/GitHub/MCP integration, or production deployment is implemented.

## Checks and packaging

```powershell
npm test
npm run dist:win
```

The Windows installer is produced in `dist/`. Unsigned development installers
may be flagged by Windows; distribute a signed build for public use. This is a
hackathon prototype, not a validated production desktop agent.

Run the existing root regression suite separately with `npm run eval` from the
repository root. Live API voice/image calls and Windows-specific foreground
detection must be validated on the actual Windows demo machine.
