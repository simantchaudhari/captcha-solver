# CAPTCHA Solver

**Automated reCAPTCHA token solver powered by Playwright + Express HTTP API**

## Overview

This project is a self-hosted HTTP service that automatically solves:

- **reCAPTCHA v2** (checkbox — the classic "I'm not a robot")
- **reCAPTCHA v2 Invisible** (triggered silently on form submit)
- **reCAPTCHA v3** (fully hidden, score-based)

It works by spinning up real Chromium browser contexts via rebrowser-playwright (an anti-bot-detection fork of Playwright), serving a lightweight HTML page that loads the captcha widget, then automating the solve and returning the token over a simple REST API.

For reCAPTCHA v2 challenges (image grids), it falls back to the Audio challenge and transcribes it via Google's Speech API — no API key needed.

---

## Requirements

- **Node.js** >= 18
- **npm** >= 9
- **Linux / macOS / Windows** (WSL recommended on Windows)
- **Internet access** (captcha scripts are loaded from Google CDN)

### Optional

Improves bot-detection evasion:
- **patchright Chromium** — if installed, the solver auto-detects and uses it.
  - Install with: `pip install patchright && patchright install chromium`

---

## Installation

1. Clone / extract the project folder, then open a terminal inside it:

   ```bash
   cd captcha-solver
   ```

2. Install Node.js dependencies:

   ```bash
   npm install
   ```

3. (Optional) Install patchright for better stealth:

   ```bash
   pip install patchright
   patchright install chromium
   ```

---

## Starting the Server

Run the main solver:

```bash
node Captcha_Solver.js
```

The server starts on port 6768 by default. You will see output like:

```
captcha solver running on http://localhost:6768
  GET http://localhost:6768/solve?type=recaptcha&url=<site>&sitekey=<key>
  ...
```

### Environment Variables

Set these before starting to customize behavior:

- `CAPTCHA_PORT` — port to listen on (default: 6768)
- `POOL_SIZE` — browser context pool size (default: 30)
- `HEADLESS` — set to "true" to run headless (default: false / visible)

**Example:**
```bash
CAPTCHA_PORT=8080 POOL_SIZE=10 HEADLESS=false node Captcha_Solver.js
```

---

## Web UI

Open your browser and visit:

```
http://localhost:6768
```

You will see the Captcha Solver dashboard where you can:

- Select captcha type from the dropdown
- Enter the Target URL (the page that hosts the captcha)
- Enter the Site Key (the data-sitekey / sitekey value from that page)
- For reCAPTCHA v3, also enter the Action name (e.g. "submit", "login")
- Click [RUN] and the token appears on screen with elapsed time
- Stats are tracked: total solved, average time, success rate

---

## REST API — /solve

All solves are via a single GET endpoint:

```
GET http://localhost:6768/solve?type=<TYPE>&url=<URL>&sitekey=<KEY>[&action=<ACTION>][&timeout=<SEC>]
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `type` | Yes | One of: `recaptcha`, `recaptcha-invisible`, `recaptcha-v3` |
| `url` | Yes | Full URL of the target site, e.g. `https://example.com/signup` (This is the page the captcha "belongs" to — used as the origin/referrer. Does NOT have to be publicly reachable; the solver intercepts the request internally.) |
| `sitekey` | Yes | The site key string found in the target page HTML, e.g. `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` |
| `action` | No | Action name for reCAPTCHA v3 only. Default: "submit" |
| `timeout` | No | Max seconds to wait for a token. Default: 60 |

### Example Requests

**reCAPTCHA v2 checkbox:**
```bash
curl "http://localhost:6768/solve?type=recaptcha&url=https://example.com&sitekey=6LeIxAcT..."
```

**reCAPTCHA v2 Invisible:**
```bash
curl "http://localhost:6768/solve?type=recaptcha-invisible&url=https://example.com&sitekey=6LeIxAcT..."
```

**reCAPTCHA v3:**
```bash
curl "http://localhost:6768/solve?type=recaptcha-v3&url=https://example.com&sitekey=6LeIxAcT...&action=login"
```

### Successful Response

```json
{
  "success": true,
  "token": "03AGdBq24PBCbwiDRaS...<long token string>...",
  "time": 4.21,
  "type": "recaptcha"
}
```

**Fields:**
- `success` — true/false
- `token` — the captcha response token to submit with your form
- `time` — seconds taken to solve
- `type` — captcha type that was solved
- `action` — (v3 only) the action name used

### Failure Response

```json
{
  "success": false,
  "err": "timeout",
  "type": "recaptcha"
}
```

**Common error values:**
- `"timeout"` — solver did not receive a token within the time limit
- `"missing url"` — url parameter not provided
- `"missing sitekey"` — sitekey parameter not provided
- `"<error message>"` — any Playwright/browser error

---

## Health Check

```
GET http://localhost:6768/health
```

Returns:
```json
{ "ok": true, "pool": 28 }
```

---

## How It Works (Internals)

1. **On startup**, the solver launches a Chromium browser and pre-warms a pool of browser contexts (default: 30) for concurrent request handling.

2. **When a /solve request arrives:**
   - A context is grabbed from the pool (or a new one is created)
   - A new page is opened and a request intercept is set so that when the page navigates to `<url>`, the server injects a minimal HTML page that loads the captcha widget script (Google CDN)
   - The solver polls the page for the response token

3. **Solving strategy per type:**
   - **recaptcha v2**: Clicks the checkbox inside the reCAPTCHA anchor iframe. If a challenge popup appears (image grid), it switches to the Audio challenge and uses Google Speech API to transcribe the audio answer.
   - **recaptcha-invisible**: Executes `grecaptcha.execute()` immediately after widget render. Handles audio challenges if shown.
   - **recaptcha-v3**: Calls `grecaptcha.execute()` with the given action, no interaction needed. Token is returned directly.

4. **On success/failure**, the page is closed, the context is returned to the pool, and the result JSON is sent back.

---

## How to Use the Token

Once you receive a token, POST it to your target form in the field that the site expects. For reCAPTCHA, use the field name `g-recaptcha-response`.

**Example with curl:**

```bash
TOKEN=$(curl -s "http://localhost:6768/solve?type=recaptcha&url=https://example.com&sitekey=KEY" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -X POST https://example.com/submit \
     -d "username=foo&password=bar&g-recaptcha-response=$TOKEN"
```

> **Note:** Tokens expire after ~2 minutes, so submit them promptly.

---


## Finding a Site Key

To find the sitekey for a target page:

1. Open the target page in your browser
2. Open DevTools → Elements (or Ctrl+U to view source)
3. Search for "sitekey" or "data-sitekey"
4. Copy the value (looks like: `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI`)

For reCAPTCHA v3, you may also find it in the script URL:
```html
<script src="https://www.google.com/recaptcha/api.js?render=<SITEKEY>"></script>
---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Server starts but /solve always returns timeout | Make sure the site key and URL match the actual captcha widget on the page. Try increasing timeout: `?timeout=120`. Check if Google is reachable from your server's IP. |
| Browser crashes or "no sandbox" errors | On Linux, ensure `--no-sandbox` is in the launch args (it is by default). In Docker: add `--shm-size=1g` to your docker run command. |
| rc_debug3.js says Chromium not found | Update the `executablePath` on line 26 to your actual Chromium binary. Or run: `npx playwright install chromium` |
| Audio challenge fails transcription | Google Speech API endpoint may rate-limit from certain IPs. The solver will retry the challenge; you can also increase timeout. |
| "context destroyed" errors in logs | These are harmless; the solver swallows them and retries automatically. |

---

## File Structure

```
Captcha_Solver.js      — Main HTTP server + all captcha solvers (run this)
package.json           — Node.js project metadata and dependencies
package-lock.json      — Locked dependency versions
README.md              — This file
```

---

## Quick Start (TL;DR)

```bash
npm install
node Captcha_Solver.js
```

Then open `http://localhost:6768` — OR — call the API directly:

```bash
curl "http://localhost:6768/solve?type=recaptcha&url=https://example.com&sitekey=YOUR_KEY"
```
