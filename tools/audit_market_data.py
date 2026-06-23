"""Validate the generated snapshot and compare latest prices with Yahoo spark."""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

from generate_market_data import fetch_chart


ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "Mozilla/5.0 (compatible; MarketLensAudit/1.0)"
VALID_SECTORS = {
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


def load_snapshot() -> dict:
    source = (ROOT / "data.js").read_text(encoding="utf-8")
    return json.loads(source[len("window.MARKET_DATA = ") : -2])


def fetch_spark(symbols: list[str]) -> dict[str, float]:
    query = urllib.parse.urlencode(
        {"symbols": ",".join(symbols), "range": "5d", "interval": "1d"}
    )
    request = urllib.request.Request(
        f"https://query1.finance.yahoo.com/v7/finance/spark?{query}",
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)

    prices = {}
    for result in payload.get("spark", {}).get("result", []):
        responses = result.get("response") or []
        closes = (
            responses[0].get("indicators", {}).get("quote", [{}])[0].get("close", [])
            if responses
            else []
        )
        valid = [value for value in closes if value is not None]
        if valid:
            prices[result["symbol"]] = float(valid[-1])
    return prices


def main() -> None:
    snapshot = load_snapshot()
    stocks = snapshot["stocks"]
    assert len(stocks) == len({stock["ticker"] for stock in stocks})
    assert all(stock["sector"] in VALID_SECTORS for stock in stocks)

    stale = []
    bad_series = []
    large_jumps = []
    for stock in stocks:
        series = stock["prices"]
        dates = [point[0] for point in series]
        prices = [float(point[1]) for point in series]
        if dates != sorted(set(dates)) or len(series) < 2 or any(price <= 0 for price in prices):
            bad_series.append(stock["ticker"])
        if dates[-1] != snapshot["asOf"]:
            stale.append((stock["ticker"], dates[-1]))
        for previous, current in zip(prices, prices[1:]):
            change = current / previous - 1
            if abs(change) > 1:
                large_jumps.append((stock["ticker"], round(change * 100, 2)))

    latest = {}
    symbols = [stock["ticker"].replace(".", "-") for stock in stocks]
    for start in range(0, len(symbols), 20):
        latest.update(fetch_spark(symbols[start : start + 20]))

    mismatches = []
    for stock in stocks:
        symbol = stock["ticker"].replace(".", "-")
        provider_price = latest.get(symbol)
        stored_price = float(stock["prices"][-1][1])
        if provider_price is None:
            mismatches.append((stock["ticker"], "missing"))
            continue
        tolerance = max(0.02, abs(provider_price) * 0.0001)
        if not math.isclose(stored_price, provider_price, abs_tol=tolerance):
            mismatches.append(
                (stock["ticker"], round(stored_price, 4), round(provider_price, 4))
            )

    stored = {stock["ticker"].replace(".", "-"): stock for stock in stocks}
    baseline_mismatches = []
    mtd_mismatches = []
    return_mismatches = []
    as_of = date.fromisoformat(snapshot["asOf"])
    month_start = as_of.replace(day=1)

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {
            executor.submit(fetch_chart, symbol): symbol for symbol in stored
        }
        for future in as_completed(futures):
            symbol = futures[future]
            _, chart = future.result()
            timestamps = chart.get("timestamp") or []
            closes = (
                chart.get("indicators", {})
                .get("quote", [{}])[0]
                .get("close", [])
            )
            daily = [
                (
                    date.fromtimestamp(timestamp),
                    float(close),
                )
                for timestamp, close in zip(timestamps, closes)
                if close is not None
            ]
            stock = stored[symbol]
            stored_prices = stock["prices"]
            provider_ytd_start = float(chart["meta"]["chartPreviousClose"])
            provider_last = daily[-1][1]
            provider_mtd_start = [
                close for day, close in daily if day < month_start
            ][-1]
            stored_ytd_start = float(stored_prices[0][1])
            stored_last = float(stored_prices[-1][1])
            stored_mtd_start = [
                float(close)
                for day, close in stored_prices
                if date.fromisoformat(day) < month_start
            ][-1]

            tolerance = max(0.02, abs(provider_last) * 0.0001)
            if not math.isclose(stored_ytd_start, provider_ytd_start, abs_tol=tolerance):
                baseline_mismatches.append(symbol)
            if not math.isclose(stored_mtd_start, provider_mtd_start, abs_tol=tolerance):
                mtd_mismatches.append(symbol)

            stored_ytd_return = stored_last / stored_ytd_start - 1
            provider_ytd_return = provider_last / provider_ytd_start - 1
            stored_mtd_return = stored_last / stored_mtd_start - 1
            provider_mtd_return = provider_last / provider_mtd_start - 1
            if not (
                math.isclose(stored_ytd_return, provider_ytd_return, abs_tol=1e-6)
                and math.isclose(stored_mtd_return, provider_mtd_return, abs_tol=1e-6)
            ):
                return_mismatches.append(symbol)

    print(f"Stocks: {len(stocks)}")
    print(f"As of: {snapshot['asOf']}")
    print(f"Sectors: {len({stock['sector'] for stock in stocks})}")
    print(f"Bad series: {len(bad_series)}")
    print(f"Stale series: {len(stale)}")
    print(f"Latest-price mismatches: {len(mismatches)}")
    print(f"YTD baseline mismatches: {len(baseline_mismatches)}")
    print(f"MTD baseline mismatches: {len(mtd_mismatches)}")
    print(f"YTD/MTD return mismatches: {len(return_mismatches)}")
    print(f"Compacted interval moves over 100%: {len(large_jumps)}")
    if bad_series:
        print("Bad:", bad_series)
    if stale:
        print("Stale:", stale)
    if mismatches:
        print("Mismatches:", mismatches)
    if large_jumps:
        print("Large moves:", large_jumps[:20])
    if baseline_mismatches:
        print("YTD baselines:", baseline_mismatches)
    if mtd_mismatches:
        print("MTD baselines:", mtd_mismatches)
    if return_mismatches:
        print("Returns:", return_mismatches)

    assert not bad_series
    assert not stale
    assert not mismatches
    assert not baseline_mismatches
    assert not mtd_mismatches
    assert not return_mismatches


if __name__ == "__main__":
    main()
