const ALPACA_URL = "https://data.alpaca.markets/v2/stocks/snapshots";
const FEED = "delayed_sip";
const CACHE_SECONDS = 300;
const BATCH_SIZE = 150;
const MAX_SYMBOLS = 600;

const jsonResponse = (payload, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });

const chunks = (items, size) => {
  const batches = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
};

const timestampDate = (value) => {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  } catch {
    return null;
  }
};

const barValue = (snapshot, key) => {
  const bar = snapshot?.[key] || {};
  return {
    price: Number.isFinite(bar.c) ? Number(bar.c) : null,
    timestamp: bar.t || null,
  };
};

const splitAdjustedPreviousClose = (previousClose, latestPrice) => {
  if (
    !Number.isFinite(previousClose) ||
    !Number.isFinite(latestPrice) ||
    previousClose <= 0 ||
    latestPrice <= 0
  ) {
    return { price: previousClose, adjusted: false, ratio: null };
  }

  const currentMove = Math.abs(latestPrice / previousClose - 1);
  if (currentMove <= 0.5) {
    return { price: previousClose, adjusted: false, ratio: null };
  }

  const splitRatios = [2, 3, 4, 5, 10, 20];
  let bestPrice = previousClose;
  let bestMove = currentMove;
  let bestRatio = null;

  for (const ratio of splitRatios) {
    for (const [candidate, label] of [
      [previousClose / ratio, ratio],
      [previousClose * ratio, 1 / ratio],
    ]) {
      const candidateMove = Math.abs(latestPrice / candidate - 1);
      if (candidateMove < bestMove && candidateMove <= 0.35) {
        bestPrice = candidate;
        bestMove = candidateMove;
        bestRatio = label;
      }
    }
  }

  return {
    price: bestPrice,
    adjusted: bestRatio !== null,
    ratio: bestRatio,
  };
};

const normalizeSnapshot = (symbol, snapshot) => {
  const minute = barValue(snapshot, "minuteBar");
  const daily = barValue(snapshot, "dailyBar");
  const previous = barValue(snapshot, "prevDailyBar");
  const trade = snapshot?.latestTrade || {};
  const price = Number.isFinite(trade.p)
    ? Number(trade.p)
    : minute.price ?? daily.price;
  const timestamp = trade.t || minute.timestamp || daily.timestamp;

  if (!Number.isFinite(price)) return null;
  const adjustedPrevious = splitAdjustedPreviousClose(previous.price, price);

  return {
    symbol,
    price: Number(price.toFixed(4)),
    timestamp,
    marketDate: timestampDate(timestamp),
    regularClose: Number.isFinite(daily.price)
      ? Number(daily.price.toFixed(4))
      : null,
    previousClose: Number.isFinite(adjustedPrevious.price)
      ? Number(adjustedPrevious.price.toFixed(4))
      : null,
    previousCloseAdjusted: adjustedPrevious.adjusted,
    previousCloseAdjustmentRatio: adjustedPrevious.ratio,
    previousDate: timestampDate(previous.timestamp),
  };
};

const readUniverseSymbols = async (request) => {
  const dataUrl = new URL("/data.js", request.url);
  const response = await fetch(dataUrl, {
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  if (!response.ok) {
    throw new Error(`Could not load the market universe (${response.status}).`);
  }

  const source = await response.text();
  const match = source.match(/^window\.MARKET_DATA\s*=\s*(.*);\s*$/s);
  if (!match) throw new Error("The market snapshot is not in the expected format.");
  const data = JSON.parse(match[1]);
  const symbols = (data.stocks || [])
    .map((stock) => String(stock.ticker || "").toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,12}$/.test(symbol));

  if (!symbols.length || symbols.length > MAX_SYMBOLS) {
    throw new Error("The market universe contains an unexpected number of symbols.");
  }
  return symbols;
};

const requestAlpacaBatch = async (symbols, env) => {
  const url = new URL(ALPACA_URL);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("feed", FEED);
  url.searchParams.set("currency", "USD");

  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": env.APCA_API_KEY_ID,
      "APCA-API-SECRET-KEY": env.APCA_API_SECRET_KEY,
      Accept: "application/json",
      "User-Agent": "MarketMovers/1.0",
    },
  });

  if (!response.ok) {
    const message = (await response.text()).slice(0, 300);
    throw new Error(`Alpaca returned HTTP ${response.status}: ${message}`);
  }
  return response.json();
};

const fetchQuotes = async (request, env) => {
  const symbols = await readUniverseSymbols(request);
  const payloads = await Promise.all(
    chunks(symbols, BATCH_SIZE).map((batch) => requestAlpacaBatch(batch, env)),
  );
  const snapshots = Object.assign(
    {},
    ...payloads.map((payload) => payload.snapshots || payload),
  );
  const quotes = {};

  for (const [symbol, snapshot] of Object.entries(snapshots)) {
    const normalized = normalizeSnapshot(symbol, snapshot);
    if (normalized) quotes[symbol] = normalized;
  }

  if (!Object.keys(quotes).length) {
    throw new Error("Alpaca did not return any stock snapshots.");
  }

  const timestamps = Object.values(quotes)
    .map((quote) => quote.timestamp)
    .filter(Boolean)
    .sort();
  return {
    source: "Alpaca",
    feed: FEED,
    delayedMinutes: 15,
    fetchedAt: new Date().toISOString(),
    marketTimestamp: timestamps.at(-1) || null,
    count: Object.keys(quotes).length,
    requested: symbols.length,
    missing: symbols.filter((symbol) => !quotes[symbol]),
    quotes,
  };
};

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) {
    return jsonResponse(
      {
        configured: false,
        error: "Alpaca credentials are not configured for this deployment.",
      },
      503,
    );
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const payload = await fetchQuotes(request, env);
    const response = jsonResponse(payload, 200, {
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    });
    waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return jsonResponse(
      {
        configured: true,
        error: error instanceof Error ? error.message : "Quote request failed.",
      },
      502,
    );
  }
}
