# Market Movers

A dashboard for comparing S&P 500 and Nasdaq-100 performance. It uses a
committed snapshot by default and 15-minute-delayed Alpaca data when configured.

Live site: https://market-movers.pages.dev/

## Key Files

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

The browser gets delayed SIP snapshots from `/api/quotes`. Credentials stay
server-side; responses are cached for five minutes; `data.js` is the fallback.

For snapshot-only use:

```powershell
python -m http.server 4173
```

## Deploy to Cloudflare Pages

`functions/api/quotes.js` is the Cloudflare Pages counterpart to the local service.

Cloudflare Pages settings:

- Framework preset: None
- Build command: leave blank
- Build output directory: `.`
- Root directory: `/`

After the first deployment, add these encrypted variables under the Pages
project's **Settings → Variables and Secrets**:

- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`

Redeploy after adding the secrets to use delayed Alpaca SIP snapshots with the
saved snapshot as a fallback.

## Refresh the Snapshot

Run:

```powershell
python tools/generate_market_data.py
```

The generator refreshes index membership and writes `data.js`.
