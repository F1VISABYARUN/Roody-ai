# Roody Credits Backend — Hostinger/PHP Deploy (~20 minutes)

Runs entirely on your Hostinger Business hosting: PHP proxy + MySQL. Your
Gemini key lives in a config file above the web root — never in the extension.

```
Extension ──(code + request)──▶ yourdomain.com/roody-proxy.php ──▶ Gemini
                                        │
                                        ▼
                              MySQL: codes + usage_log
```

## 1. Create the database (hPanel, 3 min)

1. hPanel → **Databases → Management** → Create database
   - Name: `roody` (Hostinger prefixes it, e.g. `u123456789_roody`)
   - Create a user + strong password, assign to the database
2. Note down: database name, username, password (host is `localhost`)

## 2. Load the schema + mint codes (3 min)

1. hPanel → **Databases → phpMyAdmin** → open your new database
2. **SQL** tab → paste all of `schema.sql` → **Go**
3. The last SELECT shows your two freshly minted codes — copy them,
   those go to your testers

## 3. Upload the PHP files (5 min)

1. Copy `roody-config.example.php` → rename to `roody-config.php` → fill in
   your Gemini key + the DB credentials from step 1
2. hPanel → **File Manager**:
   - Upload `roody-proxy.php` into `public_html/`
   - Upload `roody-config.php` into the folder ABOVE `public_html`
     (e.g. `domains/yourdomain.com/`) — this keeps it un-downloadable
3. Your proxy URL is now: `https://yourdomain.com/roody-proxy.php`

## 4. Smoke test (2 min)

From any terminal (or an online curl tool):

```bash
curl -s https://yourdomain.com/roody-proxy.php \
  -H 'content-type: application/json' \
  -d '{"code":"ROODY-YOURCODE","kind":"brain","model":"gemini-2.5-flash","body":{"contents":[{"parts":[{"text":"say hi in 3 words"}]}]}}'
```

- Gemini JSON reply → ✅ working
- `{"error":"invalid-code"}` → code typo or `active = 0`
- `{"error":"no-config"}` → config file not found/renamed
- `{"error":"db",...}` → DB credentials wrong

Credits check: run it 51 times → the 51st returns HTTP 402
`{"error":"out-of-credits"}`. Reset: `DELETE FROM usage_log WHERE code='ROODY-YOURCODE';`

## 5. Point the extension at it (1 min)

`src/background.js` → set:
```js
const ROODY_PROXY_URL = "https://yourdomain.com/roody-proxy.php";
```
AND `manifest.json` → replace the supabase entry in host_permissions with:
```json
"https://yourdomain.com/*"
```
Rebuild the zip → that's the build your testers get, along with their codes.

## Cost guardrails

- 50 msgs/day × user × ~₹0.4 = worst case ~₹20/user/day; most do 5-15.
- Your free-tier Gemini key works for 2 testers (rate limits shared).
  At ~5+ users, switch to a billing-enabled key + set a Google Cloud
  budget alert so a runaway day can never surprise you.
- Panic button (phpMyAdmin): `UPDATE codes SET active = 0;` — pauses everyone.
