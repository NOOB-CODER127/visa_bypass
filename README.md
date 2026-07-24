# US Visa Scheduling — Bypass Tool v2.0

## What This Fixes

Based on the official technical report:
> The calendar endpoint `POST /api/v1/.../get-family-ofc-schedule-days` returns  
> **HTTP 403 Forbidden + `cf-mitigated: challenge`** (Cloudflare) every ~7 minutes.  
> This causes **PSE0501 — Unable to load appointment available days**.

**Previous tool's failure:** All 7 scripts made direct API calls (Python or browser fetch).
Cloudflare blocks these every 7 minutes — cookie refreshing never helped.

**This tool's fix:**
1. **No API calls at all** — Selenium clicks UI buttons, reads calendar from DOM
2. **Auto-solves Cloudflare Turnstile CAPTCHA** via 2captcha or CapSolver API
3. **Persistent browser profile** — log in once, reused forever
4. **All errors auto-handled** — PSE0501, rate limits, session expiry, server outage

---

## Setup (One Time)

### 1. Install Python dependencies
```
pip install -r requirements.txt
```

### 2. Get a CAPTCHA API Key (REQUIRED for auto-solve)
- Go to https://2captcha.com — register and add balance (~$3 minimum)
- OR go to https://capsolver.com — similar pricing
- Copy your API key

### 3. Edit config.json
```json
{
    "captcha_service": "2captcha",
    "captcha_api_key": "YOUR_KEY_HERE"
}
```

### 4. (Optional) Telegram Alerts
Add your Telegram bot token and chat ID to `config.json` for instant slot alerts on your phone.

---

## Running the Tool

```
python visa_bypass.py
```

Choose from the menu:
- **[1] Start Monitoring** — runs continuously, checks all locations, alerts on slots
- **[2] Single Test Check** — one-time test to verify everything works
- **[3] Refresh Login Session** — if you get logged out, re-login manually once
- **[4] Show Config** — view current settings

---

## How It Works

```
Launch Browser (Brave/Chrome)
       ↓
Log in once → OFC page detected
       ↓
Loop:
  Click location button (CHE/HYD/KOL/MUM/DEL)
  Wait for calendar DOM to render
  ├─ If PSE0501 → dismiss popup + check for Cloudflare challenge
  │    └─ If challenge → AUTO-SOLVE via 2captcha → inject token → resume
  ├─ If calendar loads → read dates from DOM
  └─ If no slots → wait 90-150s → repeat
  
When slots found:
  Sound alert + big console banner + Telegram message
```

---

## CAPTCHA Auto-Solve Details

When Cloudflare blocks the calendar XHR (causes PSE0501):
1. The tool detects the hidden Turnstile challenge
2. Extracts the `sitekey` from the page
3. Sends it to your 2captcha/CapSolver account
4. Gets back a solved token (~10-30 seconds)
5. Injects the token → Cloudflare accepts it
6. Calendar loads normally for the next ~7 minutes

**Cost:** ~$0.001 per solve → at most ~$0.50/day for heavy monitoring.

---

## Config Reference

| Key | Default | Description |
|-----|---------|-------------|
| `locations` | All 5 | Which cities to check: CHE HYD KOL MUM DEL |
| `facility_id` | HYD facility | Change to check a different facility |
| `polling_interval_min` | 90 | Minimum seconds between full checks |
| `polling_interval_max` | 150 | Maximum seconds between full checks |
| `captcha_service` | 2captcha | `"2captcha"` or `"capsolver"` |
| `captcha_api_key` | empty | Your API key — REQUIRED for auto-solve |
| `telegram_bot_token` | empty | Optional Telegram bot token |
| `telegram_chat_id` | empty | Optional Telegram chat/user ID |
| `sound_alerts` | true | Windows sound alerts when slots found |

---

## Files

| File | Purpose |
|------|---------|
| `visa_bypass.py` | Main tool (single file, all logic inside) |
| `config.json` | Settings — edit this |
| `requirements.txt` | Python packages to install |
| `chrome_profile_bypass/` | Auto-created — stores your login session |
| `visa_bypass.log` | Auto-created — full activity log |
| `capsolver_ext/` | Auto-created if using CapSolver extension mode |
