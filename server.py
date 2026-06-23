"""Serve the dashboard and proxy delayed Alpaca market snapshots.

Alpaca credentials stay on the server and are never exposed to browser code.
The proxy caches the combined stock-universe response for five minutes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data.js"
ENV_FILE = ROOT / ".env"
ALPACA_URL = "https://data.alpaca.markets/v2/stocks/snapshots"
ALPACA_FEED = "delayed_sip"
MARKET_TIMEZONE = ZoneInfo("America/New_York")
CACHE_TTL_SECONDS = 300
BATCH_SIZE = 150
USER_AGENT = "MarketMovers/1.0"

_cache_lock = threading.Lock()
_quote_cache: dict[str, object] = {"expires": 0.0, "payload": None}


def load_env_file() -> None:
    """Load simple KEY=VALUE entries without overwriting existing environment."""

    if not ENV_FILE.exists():
        return

    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            os.environ.setdefault(key, value)


def load_symbols() -> list[str]:
    raw = DATA_FILE.read_text(encoding="utf-8").strip()
    prefix = "window.MARKET_DATA = "
    if not raw.startswith(prefix):
        raise RuntimeError("data.js is not in the expected format")
    payload = json.loads(raw[len(prefix) :].removesuffix(";"))
    return [stock["ticker"] for stock in payload.get("stocks", [])]


def chunks(items: list[str], size: int):
    for offset in range(0, len(items), size):
        yield items[offset : offset + size]


def parse_timestamp(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def bar_value(snapshot: dict, key: str) -> tuple[float | None, str | None]:
    bar = snapshot.get(key) or {}
    price = bar.get("c")
    timestamp = bar.get("t")
    return (float(price), timestamp) if price is not None else (None, timestamp)


def normalize_snapshot(symbol: str, snapshot: dict) -> dict | None:
    trade = snapshot.get("latestTrade") or {}
    price = trade.get("p")
    timestamp = trade.get("t")

    if price is None:
        price, timestamp = bar_value(snapshot, "minuteBar")
    if price is None:
        price, timestamp = bar_value(snapshot, "dailyBar")
    if price is None:
        return None

    parsed = parse_timestamp(timestamp)
    market_date = (
        parsed.astimezone(MARKET_TIMEZONE).date().isoformat() if parsed else None
    )
    regular_close, _ = bar_value(snapshot, "dailyBar")
    previous_close, previous_timestamp = bar_value(snapshot, "prevDailyBar")
    previous_parsed = parse_timestamp(previous_timestamp)
    previous_date = (
        previous_parsed.astimezone(MARKET_TIMEZONE).date().isoformat()
        if previous_parsed
        else None
    )

    return {
        "symbol": symbol,
        "price": round(float(price), 4),
        "timestamp": timestamp,
        "marketDate": market_date,
        "regularClose": (
            round(regular_close, 4) if regular_close is not None else None
        ),
        "previousClose": (
            round(previous_close, 4) if previous_close is not None else None
        ),
        "previousDate": previous_date,
    }


def request_snapshot_batch(
    symbols: list[str], api_key: str, api_secret: str
) -> dict:
    query = urllib.parse.urlencode(
        {
            "symbols": ",".join(symbols),
            "feed": ALPACA_FEED,
            "currency": "USD",
        }
    )
    request = urllib.request.Request(
        f"{ALPACA_URL}?{query}",
        headers={
            "APCA-API-KEY-ID": api_key,
            "APCA-API-SECRET-KEY": api_secret,
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_quotes(symbols: list[str]) -> dict:
    api_key = os.environ.get("APCA_API_KEY_ID")
    api_secret = os.environ.get("APCA_API_SECRET_KEY")
    if not api_key or not api_secret:
        raise RuntimeError(
            "Alpaca credentials are not configured. Add them to .env and restart."
        )

    quotes: dict[str, dict] = {}
    failures: list[str] = []

    for batch in chunks(symbols, BATCH_SIZE):
        try:
            payload = request_snapshot_batch(batch, api_key, api_secret)
            snapshots = payload.get("snapshots", payload)
            for symbol, snapshot in snapshots.items():
                normalized = normalize_snapshot(symbol, snapshot or {})
                if normalized:
                    quotes[symbol] = normalized
        except urllib.error.HTTPError as error:
            message = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Alpaca returned HTTP {error.code}: {message[:300]}"
            ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            failures.extend(batch)

    if not quotes:
        raise RuntimeError("Alpaca did not return any stock snapshots.")

    timestamps = [
        quote["timestamp"] for quote in quotes.values() if quote.get("timestamp")
    ]
    return {
        "source": "Alpaca",
        "feed": ALPACA_FEED,
        "delayedMinutes": 15,
        "fetchedAt": dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat(),
        "marketTimestamp": max(timestamps) if timestamps else None,
        "count": len(quotes),
        "requested": len(symbols),
        "missing": sorted(set(symbols) - set(quotes)),
        "temporarilyFailed": sorted(failures),
        "quotes": quotes,
    }


def cached_quotes(symbols: list[str]) -> dict:
    now = time.monotonic()
    with _cache_lock:
        cached_payload = _quote_cache["payload"]
        if cached_payload and float(_quote_cache["expires"]) > now:
            return cached_payload  # type: ignore[return-value]

        payload = fetch_quotes(symbols)
        _quote_cache["payload"] = payload
        _quote_cache["expires"] = now + CACHE_TTL_SECONDS
        return payload


class MarketMoversHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/quotes":
            try:
                self.send_json(cached_quotes(self.server.symbols))  # type: ignore[attr-defined]
            except RuntimeError as error:
                self.send_json(
                    {
                        "configured": bool(
                            os.environ.get("APCA_API_KEY_ID")
                            and os.environ.get("APCA_API_SECRET_KEY")
                        ),
                        "error": str(error),
                    },
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
            return
        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        if self.path.startswith("/api/quotes"):
            return
        super().log_message(format, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Market Movers dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    load_env_file()
    symbols = load_symbols()
    server = ThreadingHTTPServer((args.host, args.port), MarketMoversHandler)
    server.symbols = symbols  # type: ignore[attr-defined]
    configured = bool(
        os.environ.get("APCA_API_KEY_ID")
        and os.environ.get("APCA_API_SECRET_KEY")
    )
    print(f"Market Movers: http://{args.host}:{args.port}")
    print(
        f"Alpaca delayed prices: {'configured' if configured else 'not configured; snapshot fallback active'}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
