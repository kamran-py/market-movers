# Market Lens

A lightweight, dependency-free dashboard for comparing S&P 500 and Nasdaq-100
stock prices.

## Run with delayed Alpaca prices

1. Copy `.env.example` to `.env`.
2. Add an Alpaca market-data key and secret to `.env`.
3. Start the included server:

```powershell
C:\Users\kanop\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe server.py
```

Then open `http://localhost:4173`.

The browser receives 15-minute-delayed SIP snapshots from `/api/quotes`.
Credentials remain server-side, results are cached for five minutes, and the
saved `data.js` snapshot is used automatically when Alpaca is unavailable.

For snapshot-only use, `python -m http.server 4173` still works.

## Deploy through GitHub and Cloudflare Pages

The `functions/api/quotes.js` endpoint is the Cloudflare Pages equivalent of
the local Python price service.

Cloudflare Pages settings:

- Framework preset: None
- Build command: leave blank
- Build output directory: `.`
- Root directory: `/`

After the first deployment, add these encrypted variables under the Pages
project's **Settings → Variables and Secrets**:

- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`

Redeploy after adding the secrets. The public website will then use Alpaca's
15-minute-delayed SIP snapshots and retain the saved snapshot as a fallback.

## Refresh the snapshot

Run:

```powershell
C:\Users\kanop\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe tools/generate_market_data.py
```

The generator refreshes current index membership and writes a compact price
snapshot to `data.js`.
