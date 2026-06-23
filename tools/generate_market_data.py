"""Build a compact browser-ready market snapshot.

Constituents and S&P 500 GICS sectors come from the current Wikipedia index
tables. Prices come from Yahoo Finance's chart endpoint, whose close history is
already back-adjusted for stock splits, and are compacted to weekly YTD points
plus daily current-month points.
"""

from __future__ import annotations

import datetime as dt
import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import StringIO
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data.js"
USER_AGENT = "Mozilla/5.0 (compatible; MarketLens/1.0)"
SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
NASDAQ100_URL = "https://en.wikipedia.org/wiki/Nasdaq-100"
GICS_SECTORS = {
    "Energy",
    "Materials",
    "Industrials",
    "Consumer Discretionary",
    "Consumer Staples",
    "Health Care",
    "Financials",
    "Information Technology",
    "Communication Services",
    "Utilities",
    "Real Estate",
}

# Nasdaq-100 names outside the S&P 500 do not have a GICS column in the
# Nasdaq-100 source table. Keep the small non-overlap list explicit and audited.
NASDAQ_ONLY_GICS = {
    "ALNY": "Health Care",
    "ARM": "Information Technology",
    "ASML": "Information Technology",
    "CCEP": "Consumer Staples",
    "FER": "Industrials",
    "INSM": "Health Care",
    "MELI": "Consumer Discretionary",
    "MSTR": "Information Technology",
    "PDD": "Consumer Discretionary",
    "SHOP": "Information Technology",
    "TRI": "Industrials",
    "ZS": "Information Technology",
}


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def load_universe() -> list[dict]:
    sp_table = pd.read_html(StringIO(fetch_text(SP500_URL)))[0]
    ndx_tables = pd.read_html(StringIO(fetch_text(NASDAQ100_URL)))
    ndx_table = next(
        table
        for table in ndx_tables
        if {"Ticker", "Company"}.issubset(set(map(str, table.columns)))
        and len(table) >= 100
    )

    members: dict[str, dict] = {}

    for row in sp_table.to_dict("records"):
        ticker = str(row["Symbol"]).strip().upper()
        members[ticker] = {
            "ticker": ticker,
            "name": str(row["Security"]).strip(),
            "indexes": ["S&P 500"],
            "sector": str(row["GICS Sector"]).strip(),
        }

    for row in ndx_table.to_dict("records"):
        ticker = str(row["Ticker"]).strip().upper()
        if ticker in members:
            members[ticker]["indexes"].append("Nasdaq 100")
        else:
            members[ticker] = {
                "ticker": ticker,
                "name": str(row["Company"]).strip(),
                "indexes": ["Nasdaq 100"],
                "sector": NASDAQ_ONLY_GICS.get(ticker),
            }

    missing_sectors = [
        item["ticker"]
        for item in members.values()
        if item.get("sector") not in GICS_SECTORS
    ]
    if missing_sectors:
        raise RuntimeError(
            "Missing or invalid GICS sectors: " + ", ".join(sorted(missing_sectors))
        )

    return sorted(members.values(), key=lambda item: item["ticker"])


def yahoo_symbol(ticker: str) -> str:
    return ticker.replace(".", "-")


def fetch_batch(symbols: list[str]) -> dict:
    query = urllib.parse.urlencode(
        {
            "symbols": ",".join(symbols),
            "range": "ytd",
            "interval": "1d",
        }
    )
    url = f"https://query1.finance.yahoo.com/v7/finance/spark?{query}"
    return json.loads(fetch_text(url))


def fetch_chart(symbol: str) -> tuple[str, dict]:
    query = urllib.parse.urlencode(
        {
            "range": "ytd",
            "interval": "1d",
            "events": "splits",
            "includePrePost": "false",
        }
    )
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
    last_error = None
    for _ in range(3):
        try:
            payload = json.loads(fetch_text(url))
            result = payload.get("chart", {}).get("result") or []
            if not result:
                raise RuntimeError(payload.get("chart", {}).get("error") or "No chart data")
            return symbol, result[0]
        except Exception as error:  # noqa: BLE001 - retry network/provider failures
            last_error = error
    raise RuntimeError(f"{symbol}: {last_error}")


def compact_series(response: dict) -> tuple[list[list], str] | tuple[None, None]:
    timestamps = response.get("timestamp") or []
    closes = (
        response.get("indicators", {})
        .get("quote", [{}])[0]
        .get("close", [])
    )
    points = []
    for timestamp, close in zip(timestamps, closes):
        if close is None:
            continue
        day = dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc).date()
        points.append((day, round(float(close), 4)))

    if not points:
        return None, None

    as_of = points[-1][0]
    month_start = as_of.replace(day=1)
    previous_close = response.get("meta", {}).get("chartPreviousClose")

    compacted: list[tuple[dt.date, float]] = []
    if previous_close is not None:
        compacted.append(
            (dt.date(as_of.year - 1, 12, 31), round(float(previous_close), 4))
        )

    weekly: dict[tuple[int, int], tuple[dt.date, float]] = {}
    month_points = []
    pre_month = None
    for day, close in points:
        if day < month_start:
            weekly[day.isocalendar()[:2]] = (day, close)
            pre_month = (day, close)
        else:
            month_points.append((day, close))

    compacted.extend(weekly[key] for key in sorted(weekly))
    if pre_month and (not compacted or compacted[-1][0] != pre_month[0]):
        compacted.append(pre_month)
    compacted.extend(month_points)

    deduped = {}
    for day, close in compacted:
        deduped[day.isoformat()] = close

    return [[day, price] for day, price in deduped.items()], as_of.isoformat()


def main() -> None:
    universe = load_universe()
    by_yahoo = {yahoo_symbol(item["ticker"]): item for item in universe}
    symbols = list(by_yahoo)
    price_map = {}
    as_of_dates = []
    failures = []

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fetch_chart, symbol): symbol for symbol in symbols}
        for completed, future in enumerate(as_completed(futures), start=1):
            symbol = futures[future]
            try:
                _, response = future.result()
                series, as_of = compact_series(response)
                if series:
                    price_map[symbol] = series
                    as_of_dates.append(as_of)
                else:
                    failures.append(symbol)
            except Exception as error:  # noqa: BLE001 - report all failed symbols
                failures.append(f"{symbol} ({error})")
            if completed % 25 == 0 or completed == len(symbols):
                print(f"Fetched {completed}/{len(symbols)}")

    stocks = []
    missing = []
    for item in universe:
        symbol = yahoo_symbol(item["ticker"])
        series = price_map.get(symbol)
        if not series:
            missing.append(item["ticker"])
            continue
        stocks.append({**item, "prices": series})

    snapshot = {
        "asOf": max(as_of_dates) if as_of_dates else None,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "source": "Market snapshot",
        "stocks": stocks,
    }
    OUTPUT.write_text(
        "window.MARKET_DATA = "
        + json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(stocks)} stocks to {OUTPUT}")
    if missing:
        print("Missing:", ", ".join(missing))
    if failures:
        print("Fetch failures:", ", ".join(failures))


if __name__ == "__main__":
    main()
