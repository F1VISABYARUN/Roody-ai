# Roody Credits Backend — Deploy Guide

Your Gemini key lives on Supabase. Users get invite codes. 50 messages/day
each, you can raise limits or kill codes instantly.

```
Extension ──(code + request)──▶ Supabase Edge Function ──▶ Gemini
                                      │
                                      ▼
                            Postgres: codes + usage
```

## One-time setup (~20 minutes)

### 1. Database (Supabase dashboard, 3 min)

1. supabase.com → your project → **SQL Editor**
2. Paste ALL of `schema.sql` → **Run**
3. Mint your first two codes:
   ```sql
   insert into codes (code, name) values
     ('ROODY-' || upper(substr(md5(random()::text), 1, 8)), 'Tester 1'),
     ('ROODY-' || upper(substr(md5(random()::text), 1, 8)), 'Tester 2');
   select code, name from codes;
   ```
4. Copy the two codes — those go to your testers.

### 2. Edge Function (terminal, 10 min)

Needs the Supabase CLI (`npm i -g supabase`) and Docker NOT required for deploy.

```bash
cd backend
supabase login                       # opens browser
supabase link --project-ref YOUR_PROJECT_REF   # from your dashboard URL
supabase secrets set GEMINI_API_KEY=AIza...     # YOUR Gemini key — server-side only
supabase functions deploy roody-proxy --no-verify-jwt
```

Your proxy URL is:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/roody-proxy
```

### 3. Point the extension at it (1 min)

Open `src/background.js`, find:
```js
const ROODY_PROXY_URL = "";
```
Paste your URL between the quotes. Rebuild the zip. Done — every copy of the
extension now knows where your proxy lives. (Users can also override it in
Settings → Invite Code → Advanced, which is how you tested before editing.)

### 4. Smoke test (2 min)

```bash
curl -s https://YOUR_PROJECT_REF.supabase.co/functions/v1/roody-proxy \
  -H 'content-type: application/json' \
  -d '{"code":"ROODY-YOURCODE","kind":"brain","model":"gemini-2.5-flash","body":{"contents":[{"parts":[{"text":"say hi in 3 words"}]}]}}'
```
Expect a Gemini JSON reply. Run it 51 times and the 51st should return
`{"error":"out-of-credits"}` with HTTP 402. (Reset it: `delete from usage where code='ROODY-YOURCODE';`)

## Hostinger (site/ folder, 5 min)

1. hPanel → **File Manager** → `public_html`
2. Upload `site/index.html` and `site/privacy.html`
3. Your privacy policy URL for the Chrome Store listing:
   `https://yourdomain.com/privacy.html`

## Daily admin (SQL Editor)

```sql
-- who used what today
select c.name, u.code, u.count, c.daily_limit
from usage u join codes c using (code)
where day = current_date order by u.count desc;

-- mint a new code
insert into codes (code, name) values ('ROODY-' || upper(substr(md5(random()::text), 1, 8)), 'Friend 3');

-- kill a code
update codes set active = false where code = 'ROODY-XXXXXXXX';

-- your total Gemini exposure today (all users)
select sum(count) as total_messages from usage where day = current_date;
```

## Cost guardrails

- 50 msgs/day × N users × ~₹0.4 = worst case ₹20/user/day. 10 users maxing
  out = ₹200/day. Most users do 5-15 messages.
- The Gemini FREE tier key also works here (rate limits shared across all
  users — fine for 2 testers, upgrade to a billing-enabled key at ~5+ users).
- Hard ceiling: set a budget alert in Google Cloud Console on the key's
  project. If it trips, `update codes set active = false;` pauses everyone.
