# Market Movers

A lightweight dashboard for comparing S&P 500 and Nasdaq-100 stock performance.
It can run from a committed snapshot or from 15-minute-delayed Alpaca market
data when API credentials are available.

Live site: https://market-movers.pages.dev/

## What To Inspect First

- `index.html`, `app.js`, `styles.css`: browser dashboard.
- `data.js`: committed fallback market snapshot.
- `server.py`: local quote proxy for delayed Alpaca prices.
- `functions/api/quotes.js`: Cloudflare Pages quote endpoint.
- `tools/generate_market_data.py`: snapshot refresh script.

## Run Locally

1. Copy `.env.example` to `.env`.
2. Add an Alpaca market-data key and secret to `.env`.
3. Start the included server:

```powershell
python server.py
```

Then open `http://localhost:4173`.

The browser receives 15-minute-delayed SIP snapshots from `/api/quotes`.
Credentials remain server-side, results are cached for five minutes, and the
saved `data.js` snapshot is used automatically when Alpaca is unavailable.

For snapshot-only use:

```powershell
python -m http.server 4173
```

## Deploy Through GitHub And Cloudflare Pages

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
python tools/generate_market_data.py
```

The generator refreshes current index membership and writes a compact price
snapshot to `data.js`.
