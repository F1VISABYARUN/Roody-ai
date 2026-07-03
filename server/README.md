# Roody Credits Proxy — Hostinger Node.js + GitHub Deploy

The founder's Gemini key lives in an hPanel environment variable. Invite
codes live in another env variable. Push to GitHub → Hostinger redeploys.
No database needed for v1 (daily counters are in-memory — fine for a few
trusted testers; add MySQL when strangers arrive).

## Deploy (~10 minutes)

### 1. Create the Node.js app

1. hPanel → **Websites → Node.js** → create new application
2. Connect **GitHub** → pick the repo `F1VISABYARUN/Roody-ai`
3. Branch: the branch you deploy from (e.g. `claude/roody-k6s5sb` or `main`
   after merging)
4. Build command: *(leave empty — zero dependencies)*
5. Start command: `npm start`
   (entry file is `server/index.js`, declared in the root `package.json`)

### 2. Environment variables (in the app's settings)

| Name | Value |
|------|-------|
| `GEMINI_API_KEY` | `AIza...` — your key, server-side only |
| `ROODY_CODES` | `ROODY-TESTER01,ROODY-TESTER02` — invent any codes you like |
| `DAILY_LIMIT` | `50` |

You invent the codes yourself here — no database, no minting queries.
Give one code to each tester.

### 3. Deploy & test

1. Hit **Deploy** — Hostinger pulls the repo and starts the app
2. Open the app's URL in a browser (Hostinger shows it — either a
   subdomain it assigns or your attached domain). You should see:
   ```json
   { "ok": true, "service": "roody-proxy", "codes_loaded": 2, "daily_limit": 50, "key_set": true }
   ```
   - `codes_loaded: 0` → ROODY_CODES env var missing/typo
   - `key_set: false` → GEMINI_API_KEY missing
3. Full test from any terminal:
   ```bash
   curl -s https://YOUR-APP-URL/ -H 'content-type: application/json' \
     -d '{"code":"ROODY-TESTER01","kind":"brain","model":"gemini-2.5-flash","body":{"contents":[{"parts":[{"text":"say hi in 3 words"}]}]}}'
   ```
   A Gemini JSON reply = live. ✅

### 4. Point the extension at it

`src/background.js` → `const ROODY_PROXY_URL = "https://YOUR-APP-URL/";`
`manifest.json` → host_permissions: add `"https://YOUR-APP-URL-DOMAIN/*"`
Rebuild the tester zip.

## Admin

- **Add/revoke a code**: edit `ROODY_CODES` in hPanel → restart the app.
- **Raise limits**: edit `DAILY_LIMIT` → restart.
- **Panic button**: clear `ROODY_CODES` → restart. Everyone paused.
- **Watch usage**: the app logs each start with its config; for per-user
  numbers, upgrade to the MySQL version (backend-php/schema.sql has the
  schema) when it matters.

## Known v1 tradeoffs (deliberate)

- Counters reset when the app restarts/redeploys → testers may occasionally
  get bonus messages. Harmless at this scale.
- No usage dashboard yet. Your Google AI Studio usage page shows total
  Gemini consumption meanwhile.
