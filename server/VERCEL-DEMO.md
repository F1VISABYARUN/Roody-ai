# Roody demo on Vercel

The owner OpenAI key stays on the server. Guests enter the demo server address
and a code in the orb's Settings. Encoding a key in a ZIP does not protect it.

## Owner setup

1. Import this repository into Vercel, selecting the branch with these changes.
   Choose Framework **Other**, repository root, and Node 22 or newer. The
   repository's vercel.json configures the API and static admin page.
2. Add **Upstash Redis** through Vercel Marketplace and connect it to the project.
   The server needs its HTTPS REST URL and REST token for persistent balances.
3. In Vercel Project Settings → Environment Variables, add:
   - `OPENAI_API_KEY`: your project key with billing and Realtime access.
   - `ADMIN_KEY`: a long, randomly generated owner password.
   - `UPSTASH_REDIS_REST_URL`: the database HTTPS REST address.
   - `UPSTASH_REDIS_REST_TOKEN`: its REST token.
   - Optional `DEMO_DAILY_CREDITS`: shared daily allowance, default 1000.
   - Optional `ROODY_DEMO_CODES`: comma-separated existing guest codes.
4. Deploy or redeploy after setting variables. Enable Fluid Compute and confirm
   the configured 300-second function duration is supported. Voice schedules
   an OpenAI call hangup after 180 seconds through waitUntil; do not shorten
   the function duration.
5. Open `https://YOUR-PROJECT.vercel.app/demo-admin.html`. Enter **ADMIN_KEY**,
   then create a guest code. This page never needs the OpenAI key.
6. Give guests the server address and their code. They open orb Settings,
   enter both, click **Save demo access**, return to the orb, and press **Talk**.

Ensure Vercel Deployment Protection does not require public guests to log in
with Vercel. Keep the owner password and OpenAI key private.

## Allowance and limits

A code has 100 total app credits. Text costs 1; a voice session reserves 30
for up to 3 minutes. Pausing early does not refund a started session. Provider
failure before call creation refunds its reservation. One voice session per
code can run at a time. Sharing a code shares its balance. Credits survive
extension reinstalls and server restarts; deleting Redis data resets them.
These credits do not represent OpenAI dollars or token usage.

Both the orb and the server end demo voice after three minutes. The server
retries hangup failures and retains the voice lock if shutdown is unconfirmed.
Hosting or network failures can interrupt background tasks. This hackathon
mechanism is not an unconditional billing ceiling. Test a real deployed call
before handing out codes and monitor OpenAI usage. Vercel background runtime
also consumes hosting usage.

## Checks

Use Node 20+ and run `npm ci`, then `node --test eval/*.test.js`.
Gateway tests use mock OpenAI and Redis responses. They do not validate a live
Vercel deployment, microphone, billing, or background-task persistence.
The existing `npm start` command still starts the legacy Hostinger proxy.
