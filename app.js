(() => {
  "use strict";

  const data = window.MARKET_DATA;
  if (!data?.stocks?.length) {
    document.body.innerHTML = "<p>Market data could not be loaded.</p>";
    return;
  }
  const snapshotAsOf = data.asOf;

  const colors = [
    "#0072B2",
    "#D55E00",
    "#009E73",
    "#CC79A7",
    "#E69F00",
    "#56B4E9",
    "#6F4E7C",
    "#7F7F7F",
  ];
  const sectorOrder = [
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
  ];
  const stockMap = new Map(data.stocks.map((stock) => [stock.ticker, stock]));
  const preferred = ["AAPL", "MSFT", "NVDA", "AMZN"];
  const saved = JSON.parse(localStorage.getItem("marketLensSelected") || "null");
  const initial = Array.isArray(saved) ? saved : preferred;

  const state = {
    selected: initial.filter((ticker) => stockMap.has(ticker)).slice(0, 8),
    sector: "all",
    subIndustry: "all",
    chartView: "panels",
    chartPeriod: "YTD",
    chartMetric: "percent",
    moversPeriod: "YTD",
    moverPages: { gainers: 1, losers: 1 },
    liveStatus: "snapshot",
    liveRefreshPending: false,
  };

  const els = {
    search: document.querySelector("#stockSearch"),
    results: document.querySelector("#searchResults"),
    selected: document.querySelector("#selectedStocks"),
    summary: document.querySelector("#summaryStrip"),
    gainers: document.querySelector("#gainersTable"),
    losers: document.querySelector("#losersTable"),
    gainersPagination: document.querySelector("#gainersPagination"),
    losersPagination: document.querySelector("#losersPagination"),
    gainersRange: document.querySelector("#gainersRange"),
    losersRange: document.querySelector("#losersRange"),
    sectorFilters: document.querySelector("#sectorFilters"),
    classificationNote: document.querySelector("#classificationNote"),
    toast: document.querySelector("#toast"),
  };

  const escapeHtml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const formatPrice = (value) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: value >= 100 ? 2 : 2,
      maximumFractionDigits: 2,
    }).format(value);

  const formatSignedPrice = (value) =>
    `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;

  const formatPercent = (value) =>
    `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;

  const displayDate = (iso, options = {}) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: options.year ? "numeric" : undefined,
    }).format(new Date(`${iso}T12:00:00`));

  const displayTimestamp = (iso) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    }).format(new Date(iso));

  function periodSeries(stock, period) {
    const prices = stock.prices;
    if (period === "YTD") return prices;
    if (period === "1D") return prices.slice(-2);

    const asOf = new Date(`${data.asOf}T12:00:00`);
    const monthStart = new Date(asOf.getFullYear(), asOf.getMonth(), 1);
    let baseline = null;
    const currentMonth = [];

    prices.forEach(([date, price]) => {
      const parsed = new Date(`${date}T12:00:00`);
      if (parsed < monthStart) baseline = [date, price];
      else currentMonth.push([date, price]);
    });

    return baseline ? [baseline, ...currentMonth] : currentMonth;
  }

  function performance(stock, period) {
    const series = periodSeries(stock, period);
    if (series.length < 2) return { dollar: 0, percent: 0, current: series[0]?.[1] || 0 };
    const start = series[0][1];
    const current = series[series.length - 1][1];
    const dollar = current - start;
    return { dollar, percent: (dollar / start) * 100, current };
  }

  function membershipHtml(stock) {
    return stock.indexes
      .map(
        (index) =>
          `<span class="index-badge ${index === "Nasdaq 100" ? "ndx" : ""}">${
            index === "Nasdaq 100" ? "NDX" : "S&P"
          }</span>`,
      )
      .join("");
  }

  function subIndustryFor(stock) {
    return (
      stock.gicsSubIndustry ||
      stock.subIndustry ||
      stock.subsector ||
      window.GICS_SUB_INDUSTRIES?.[stock.ticker] ||
      ""
    );
  }

  function activeUniverse() {
    return data.stocks.filter(
      (stock) =>
        (state.sector === "all" || stock.sector === state.sector) &&
        (state.subIndustry === "all" || subIndustryFor(stock) === state.subIndustry),
    );
  }

  function updateUniverseLabels() {
    const filtered = activeUniverse();
    const scope = [
      state.sector === "all" ? null : state.sector,
      state.subIndustry === "all" ? null : state.subIndustry,
    ]
      .filter(Boolean)
      .join(" · ");
    document.querySelector("#universeCount").textContent =
      `${filtered.length} shown of ${data.stocks.length} listings${scope ? ` · ${scope}` : ""}`;
  }

  function renderSectorFilters() {
    const counts = new Map(
      sectorOrder.map((sector) => [
        sector,
        data.stocks.filter((stock) => stock.sector === sector).length,
      ]),
    );
    const subIndustryCounts = new Map();
    data.stocks.forEach((stock) => {
      const subIndustry = subIndustryFor(stock);
      if (!subIndustry) return;
      const key = `${stock.sector}||${subIndustry}`;
      subIndustryCounts.set(key, (subIndustryCounts.get(key) || 0) + 1);
    });
    const subIndustriesBySector = new Map(
      sectorOrder.map((sector) => [
        sector,
        [...subIndustryCounts.keys()]
          .filter((key) => key.startsWith(`${sector}||`))
          .map((key) => key.split("||")[1])
          .sort((a, b) => a.localeCompare(b)),
      ]),
    );
    els.sectorFilters.innerHTML = [
      `<button class="sector-filter ${state.sector === "all" ? "active" : ""}" data-sector="all">
        <span>All sectors</span><span class="sector-filter-count">${data.stocks.length}</span>
      </button>`,
      ...sectorOrder.map(
        (sector) => {
          const isActiveSector = state.sector === sector;
          const subIndustries = subIndustriesBySector.get(sector) || [];
          return `
            <div class="sector-group ${isActiveSector ? "expanded" : ""}">
              <button class="sector-filter ${isActiveSector && state.subIndustry === "all" ? "active" : ""}" data-sector="${escapeHtml(sector)}">
                <span>${sector}</span><span class="sector-filter-count">${counts.get(sector)}</span>
              </button>
              ${
                isActiveSector && subIndustries.length
                  ? `<div class="subindustry-list">
                      ${subIndustries
                        .map(
                          (subIndustry) => `
                            <button class="subindustry-filter ${state.subIndustry === subIndustry ? "active" : ""}" data-sector-name="${escapeHtml(sector)}" data-sub-industry="${escapeHtml(subIndustry)}">
                              <span>${escapeHtml(subIndustry)}</span>
                              <span class="sector-filter-count">${subIndustryCounts.get(`${sector}||${subIndustry}`)}</span>
                            </button>`,
                        )
                        .join("")}
                    </div>`
                  : ""
              }
            </div>`;
        },
      ),
    ].join("");
  }

  function renderSubIndustryFilter() {
    if (els.classificationNote) {
      const meta = window.GICS_SUB_INDUSTRIES_META;
      els.classificationNote.textContent = meta
        ? `${meta.matchedTickers} of ${meta.universeTickers} tickers mapped. Sub-industries are grouped under their sector.`
        : "Sub-Industry source loaded.";
    }
  }

  function setUniverseCounts() {
    setPriceStatus("snapshot");
    renderSectorFilters();
    renderSubIndustryFilter();
    updateUniverseLabels();
  }

  function setPriceStatus(status, payload = null) {
    state.liveStatus = status;
    const label = document.querySelector("#snapshotLabel");
    const dot = document.querySelector(".status-dot");
    const footer = document.querySelector("#footerTimestamp");
    dot.classList.toggle("loading", status === "loading");
    dot.classList.toggle("live", status === "live");
    dot.classList.toggle("offline", status === "snapshot");

    if (status === "loading") {
      label.textContent = "Updating delayed prices";
      return;
    }
    if (status === "live" && payload) {
      const timestamp = payload.marketTimestamp || payload.fetchedAt;
      label.textContent = `Alpaca · 15 min delayed · ${displayTimestamp(timestamp)}`;
      footer.textContent = `${payload.count} delayed prices updated · ${displayTimestamp(payload.fetchedAt)}`;
      return;
    }

    label.textContent = `Snapshot · ${displayDate(snapshotAsOf, { year: true })}`;
    footer.textContent = `Prices through ${displayDate(snapshotAsOf, { year: true })}`;
  }

  function mergePricePoint(stock, date, price) {
    if (!date || !Number.isFinite(price)) return false;
    const last = stock.prices[stock.prices.length - 1];
    if (date < last[0]) return false;
    if (date === last[0]) last[1] = price;
    else stock.prices.push([date, price]);
    return true;
  }

  function splitAdjustedPreviousClose(previousClose, latestPrice) {
    if (!Number.isFinite(previousClose) || !Number.isFinite(latestPrice) || previousClose <= 0 || latestPrice <= 0) {
      return previousClose;
    }
    const currentMove = Math.abs(latestPrice / previousClose - 1);
    if (currentMove <= 0.5) return previousClose;

    const splitRatios = [2, 3, 4, 5, 10, 20];
    let best = previousClose;
    let bestMove = currentMove;

    splitRatios.forEach((ratio) => {
      [previousClose / ratio, previousClose * ratio].forEach((candidate) => {
        const candidateMove = Math.abs(latestPrice / candidate - 1);
        if (candidateMove < bestMove && candidateMove <= 0.35) {
          best = candidate;
          bestMove = candidateMove;
        }
      });
    });

    return best;
  }

  function applyLiveQuotes(payload) {
    let updated = 0;
    let latestDate = data.asOf;
    Object.entries(payload.quotes || {}).forEach(([ticker, quote]) => {
      const stock = stockMap.get(ticker);
      if (!stock) return;
      if (quote.previousDate && Number.isFinite(quote.previousClose)) {
        const adjustedPreviousClose = splitAdjustedPreviousClose(quote.previousClose, quote.price);
        mergePricePoint(stock, quote.previousDate, adjustedPreviousClose);
      }
      if (mergePricePoint(stock, quote.marketDate, quote.price)) {
        updated += 1;
        if (quote.marketDate > latestDate) latestDate = quote.marketDate;
      }
    });
    data.asOf = latestDate;
    return updated;
  }

  async function refreshLivePrices() {
    if (state.liveRefreshPending || document.hidden) return;
    state.liveRefreshPending = true;
    setPriceStatus("loading");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("/api/quotes", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Price service returned ${response.status}`);
      const payload = await response.json();
      const updated = applyLiveQuotes(payload);
      if (!updated) throw new Error("No matching delayed prices were returned");
      setPriceStatus("live", payload);
      renderComparison();
      renderMovers();
    } catch (error) {
      console.info("Using the saved market snapshot:", error.message);
      setPriceStatus("snapshot");
    } finally {
      clearTimeout(timeout);
      state.liveRefreshPending = false;
    }
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function persistSelection() {
    localStorage.setItem("marketLensSelected", JSON.stringify(state.selected));
  }

  function addStock(ticker) {
    if (state.selected.includes(ticker)) {
      showToast(`${ticker} is already in the comparison`);
      return;
    }
    if (state.selected.length >= 8) {
      showToast("Remove a listing before adding another");
      return;
    }
    state.selected.push(ticker);
    persistSelection();
    els.search.value = "";
    closeSearch();
    renderComparison();
  }

  function removeStock(ticker) {
    state.selected = state.selected.filter((item) => item !== ticker);
    persistSelection();
    renderComparison();
  }

  function renderSelected() {
    if (!state.selected.length) {
      els.selected.innerHTML = '<span class="chart-kicker">No listings selected</span>';
      return;
    }
    els.selected.innerHTML = state.selected
      .map((ticker, index) => {
        const stock = stockMap.get(ticker);
        return `
          <button class="stock-chip" data-remove="${ticker}" style="--series-color:${colors[index]}">
            <span class="color-dot"></span>
            <strong>${ticker}</strong>
            <span class="membership">${membershipHtml(stock)}</span>
            <span class="remove" aria-hidden="true">×</span>
            <span class="sr-only">Remove ${escapeHtml(stock.name)}</span>
          </button>`;
      })
      .join("");
  }

  function renderSummary() {
    if (!state.selected.length) {
      els.summary.innerHTML = "";
      return;
    }
    els.summary.innerHTML = `
      <div class="comparison-head">
        <span>Ticker</span><span>Index</span><span>Name</span><span>Last</span>
        <span>1D Chg %</span><span>YTD Chg %</span><span>MTD Chg %</span>
      </div>
      ${state.selected
        .map((ticker, index) => {
          const stock = stockMap.get(ticker);
          const daily = performance(stock, "1D");
          const ytd = performance(stock, "YTD");
          const mtd = performance(stock, "MTD");
          return `
            <div class="comparison-row">
              <span class="comparison-ticker" style="--series-color:${colors[index]}">
                <i class="color-dot"></i><strong>${ticker}</strong>
              </span>
              <span class="membership">${membershipHtml(stock)}</span>
              <span class="comparison-name">${escapeHtml(stock.name)}</span>
              <span>${formatPrice(ytd.current)}</span>
              <span class="${daily.percent >= 0 ? "positive" : "negative"}">${formatPercent(daily.percent)}</span>
              <span class="${ytd.percent >= 0 ? "positive" : "negative"}">${formatPercent(ytd.percent)}</span>
              <span class="${mtd.percent >= 0 ? "positive" : "negative"}">${formatPercent(mtd.percent)}</span>
            </div>`;
        })
        .join("")}`;
  }

  const svgNode = (name, attrs = {}) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };

  function niceExtent(min, max, metric) {
    if (min === max) {
      const pad = metric === "percent" ? 2 : Math.max(1, Math.abs(min) * 0.05);
      return [min - pad, max + pad];
    }
    const pad = (max - min) * 0.12;
    return [min - pad, max + pad];
  }

  function nicePercentScale(min, max) {
    const observedRange = Math.max(max - min, 1);
    const paddedMin = Math.min(0, min - observedRange * 0.05);
    const paddedMax = Math.max(0, max + observedRange * 0.05);
    const roughStep = Math.max((paddedMax - paddedMin) / 5, 0.1);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalized = roughStep / magnitude;
    const niceNormalized =
      normalized <= 1.5 ? 1 : normalized <= 3 ? 2 : normalized <= 7 ? 5 : 10;
    const step = niceNormalized * magnitude;
    const scaleMin = Math.floor(paddedMin / step) * step;
    const scaleMax = Math.ceil(paddedMax / step) * step;
    const ticks = [];

    for (let value = scaleMin; value <= scaleMax + step / 2; value += step) {
      ticks.push(Math.abs(value) < step / 1000 ? 0 : value);
    }

    return { min: scaleMin, max: scaleMax, step, ticks };
  }

  function resolveLabelSlots(labels, top, bottom, minGap = 18) {
    const sorted = [...labels].sort((left, right) => left.targetY - right.targetY);
    sorted.forEach((label, index) => {
      label.y = Math.max(top, Math.min(bottom, label.targetY));
      if (index > 0) label.y = Math.max(label.y, sorted[index - 1].y + minGap);
    });

    for (let index = sorted.length - 2; index >= 0; index -= 1) {
      sorted[index].y = Math.min(sorted[index].y, sorted[index + 1].y - minGap);
    }

    sorted.forEach((label) => {
      label.y = Math.max(top, Math.min(bottom, label.y));
    });

    return sorted;
  }

  function monthStartTicks(minTime, maxTime) {
    const minDate = new Date(minTime);
    const first = new Date(minDate.getFullYear(), minDate.getMonth(), 1, 12);
    if (first.getTime() < minTime) first.setMonth(first.getMonth() + 1);

    const ticks = [];
    for (const tick = new Date(first); tick.getTime() <= maxTime; tick.setMonth(tick.getMonth() + 1)) {
      ticks.push(tick.getTime());
    }

    return ticks.length ? ticks : [minTime, maxTime].filter((time, index, list) => index === 0 || time !== list[0]);
  }

  const metricLabel = (metric, value) => {
    if (metric === "price") return formatPrice(value);
    if (metric === "wealth") return `$${value.toFixed(0)}`;
    return formatPercent(value);
  };

  function chartSeries(stock, period, metric, index) {
    const raw = periodSeries(stock, period);
    const base = raw[0][1];
    let peakWealth = 100;
    const points = raw.map(([date, price]) => {
      const percent = ((price / base) - 1) * 100;
      const wealth = price / base * 100;
      peakWealth = Math.max(peakWealth, wealth);
      const drawdown = (wealth / peakWealth - 1) * 100;
      const values = { percent, wealth, drawdown, price };
      return {
        date,
        time: new Date(`${date}T12:00:00`).getTime(),
        raw: price,
        percent,
        wealth,
        drawdown,
        value: values[metric],
      };
    });
    return {
      stock,
      color: colors[index],
      points,
      finalPercent: points.at(-1)?.percent ?? 0,
    };
  }

  function groupedSeries(series) {
    const groups = [
      { key: "large", title: "Large gainers", subtitle: "Own scale · 0% baseline", items: [] },
      { key: "moderate", title: "Moderate movers", subtitle: "Own scale · 0% baseline", items: [] },
      { key: "decliners", title: "Decliners", subtitle: "Own scale · 0% baseline", items: [] },
    ];
    series.forEach((item) => {
      if (item.finalPercent >= 100) groups[0].items.push(item);
      else if (item.finalPercent <= -20) groups[2].items.push(item);
      else groups[1].items.push(item);
    });
    return groups.filter((group) => group.items.length);
  }

  function axisFor(values, metric) {
    if (metric === "percent" || metric === "drawdown") {
      return nicePercentScale(Math.min(...values, 0), Math.max(...values, 0));
    }
    const baseline = metric === "wealth" ? 100 : null;
    const min = Math.min(...values, baseline ?? values[0]);
    const max = Math.max(...values, baseline ?? values[0]);
    const [scaleMin, scaleMax] = niceExtent(min, max, metric);
    return {
      min: scaleMin,
      max: scaleMax,
      ticks: Array.from({ length: 4 }, (_, index) => scaleMin + ((scaleMax - scaleMin) * index) / 3),
    };
  }

  function renderChart() {
    const period = state.chartPeriod;
    const svg = document.querySelector("#chartMain");
    const legend = document.querySelector("#legendMain");
    const tooltip = document.querySelector("#tooltipMain");
    const metric = state.chartMetric;
    const selectedStocks = state.selected.map((ticker) => stockMap.get(ticker));
    const periodLabels = {
      YTD: ["From Dec 31 close", "Year to date", "Year-to-date"],
      MTD: ["From prior month close", "Month to date", "Month-to-date"],
      "1D": ["From prior close", "Daily change", "Daily"],
    };
    const metricNames = {
      percent: "% change",
      wealth: "$100 wealth index",
      drawdown: "drawdown",
      price: "price",
    };
    const [kicker, title, ariaPeriod] = periodLabels[period] || periodLabels.YTD;
    const chartKicker = document.querySelector("#chartKicker");
    chartKicker.textContent =
      `${kicker} · ${state.chartView === "panels" ? "grouped panels" : "combined scale"} · ${metricNames[metric]}`;
    document.querySelector("#chartTitle").textContent = title;
    svg.setAttribute("aria-label", `${ariaPeriod} ${metricNames[metric]} chart`);
    svg.replaceChildren();
    if (legend) legend.innerHTML = "";

    if (!selectedStocks.length) {
      svg.style.height = "";
      svg.setAttribute("viewBox", "0 0 1200 360");
      const text = svgNode("text", { x: 600, y: 180, "text-anchor": "middle", class: "axis-label" });
      text.textContent = "Search for a stock to begin";
      svg.append(text);
      return;
    }

    const series = selectedStocks.map((stock, index) => chartSeries(stock, period, metric, index));
    const allPoints = series.flatMap((item) => item.points);
    const minTime = Math.min(...allPoints.map((point) => point.time));
    const maxTime = Math.max(...allPoints.map((point) => point.time));
    const groups = state.chartView === "panels" ? groupedSeries(series) : [{ title: "Combined scale", subtitle: "", items: series }];
    const width = 1200;
    const panelHeight = state.chartView === "panels" ? 166 : 360;
    const height = groups.length * panelHeight + 30;
    const margin = { top: 24, right: 168, bottom: 30, left: 56 };
    const plotWidth = width - margin.left - margin.right;
    svg.style.height = `${Math.max(390, height)}px`;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const x = (time) => margin.left + ((time - minTime) / (maxTime - minTime || 1)) * plotWidth;
    const dateTicks = monthStartTicks(minTime, maxTime);
    const hoverLines = [];

    groups.forEach((group, groupIndex) => {
      const top = margin.top + groupIndex * panelHeight;
      const bottom = top + panelHeight - (groupIndex === groups.length - 1 ? margin.bottom : 12);
      const plotHeight = bottom - top;
      const values = group.items.flatMap((item) => item.points.map((point) => point.value));
      const axis = axisFor(values, metric);
      const y = (value) => top + (1 - (value - axis.min) / (axis.max - axis.min || 1)) * plotHeight;

      const titleText = svgNode("text", { x: margin.left, y: top - 8, class: "panel-title" });
      titleText.textContent = group.title;
      const subtitleText = svgNode("text", { x: margin.left + 96, y: top - 8, class: "panel-subnote" });
      subtitleText.textContent = state.chartView === "panels" ? group.subtitle : "";
      svg.append(titleText, subtitleText);

      axis.ticks.forEach((value) => {
        const yPos = y(value);
        const isBaseline =
          (metric === "wealth" && Math.abs(value - 100) < 0.0001) ||
          ((metric === "percent" || metric === "drawdown") && Math.abs(value) < 0.0001);
        const line = svgNode("line", {
          x1: margin.left,
          y1: yPos,
          x2: width - margin.right,
          y2: yPos,
          class: `grid-line ${isBaseline ? "zero-line" : ""}`,
        });
        const label = svgNode("text", {
          x: margin.left - 8,
          y: yPos + 3,
          "text-anchor": "end",
          class: "axis-label",
        });
        label.textContent = metricLabel(metric, value).replace("+", "");
        svg.append(line, label);
      });

      if (metric === "wealth" && axis.min < 100 && axis.max > 100 && !axis.ticks.some((tick) => Math.abs(tick - 100) < 0.001)) {
        const yPos = y(100);
        svg.append(svgNode("line", { x1: margin.left, y1: yPos, x2: width - margin.right, y2: yPos, class: "grid-line zero-line" }));
      }

      if ((metric === "percent" || metric === "drawdown") && axis.min < 0 && axis.max > 0 && !axis.ticks.includes(0)) {
        const yPos = y(0);
        svg.append(svgNode("line", { x1: margin.left, y1: yPos, x2: width - margin.right, y2: yPos, class: "grid-line zero-line" }));
      }

      const endLabels = [];
      group.items.forEach((item) => {
        const pathData = item.points
          .map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`)
          .join(" ");
        const path = svgNode("path", { d: pathData, class: "series-path", style: `--series-color:${item.color}` });
        const end = item.points.at(-1);
        const dot = svgNode("circle", { cx: x(end.time), cy: y(end.value), r: 3.8, class: "series-end", style: `--series-color:${item.color}` });
        endLabels.push({
          ticker: item.stock.ticker,
          value: end.value,
          color: item.color,
          x: x(end.time),
          targetY: y(end.value),
        });
        svg.append(path, dot);
      });

      resolveLabelSlots(endLabels, top + 8, bottom - 8).forEach((label) => {
        if (Math.abs(label.y - label.targetY) > 2) {
          svg.append(svgNode("line", {
            x1: label.x + 5,
            y1: label.targetY,
            x2: width - margin.right + 8,
            y2: label.y,
            class: "label-leader",
            style: `--series-color:${label.color}`,
          }));
        }
        const endLabel = svgNode("text", {
          x: width - margin.right + 12,
          y: label.y + 4,
          class: "series-end-label",
          style: `--series-color:${label.color}`,
        });
        endLabel.textContent = `${label.ticker} ${metricLabel(metric, label.value)}`;
        svg.append(endLabel);
      });

      const hoverLine = svgNode("line", { y1: top, y2: bottom, class: "hover-line" });
      hoverLines.push(hoverLine);
      svg.append(hoverLine);
    });

    dateTicks.forEach((time) => {
      const xPos = x(time);
      const label = svgNode("text", {
        x: xPos,
        y: height - 8,
        "text-anchor": "middle",
        class: "axis-label",
      });
      label.textContent = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(time));
      svg.append(label);
    });

    const hitbox = svgNode("rect", {
      x: margin.left,
      y: margin.top - 16,
      width: plotWidth,
      height: height - margin.top,
      class: "chart-hitbox",
    });
    svg.append(hitbox);

    const timeline = [...new Set(allPoints.map((point) => point.time))].sort((left, right) => left - right);
    hitbox.addEventListener("pointermove", (event) => {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const matrix = svg.getScreenCTM();
      const svgPoint = matrix ? point.matrixTransform(matrix.inverse()) : point;
      const plotX = Math.max(margin.left, Math.min(width - margin.right, svgPoint.x));
      const targetTime = minTime + ((plotX - margin.left) / plotWidth) * (maxTime - minTime);
      const anchorTime = timeline.reduce((best, time) =>
        Math.abs(time - targetTime) < Math.abs(best - targetTime) ? time : best,
      );
      const rows = series.map((item) => {
        const nearest = item.points.reduce((best, point) =>
          Math.abs(point.time - anchorTime) < Math.abs(best.time - anchorTime) ? point : best,
        );
        return { stock: item.stock, point: nearest, color: item.color };
      });
      const anchorDate = new Date(anchorTime).toISOString().slice(0, 10);
      const hoverX = x(anchorTime);
      hoverLines.forEach((line) => {
        line.setAttribute("x1", hoverX);
        line.setAttribute("x2", hoverX);
        line.style.opacity = "0.65";
      });
      tooltip.hidden = false;
      tooltip.innerHTML = `
        <span class="tip-date">${displayDate(anchorDate, { year: true })}</span>
        ${rows
          .map(
            ({ stock, point, color }) => `
              <span class="tip-row" style="--series-color:${color}">
                <span>${stock.ticker}</span>
                <strong>${metric === "percent" ? formatPercent(point.percent) : `${metricLabel(metric, point.value)} · ${formatPercent(point.percent)}`}</strong>
              </span>`,
          )
          .join("")}`;
      const stage = svg.parentElement;
      const stageWidth = stage.clientWidth;
      const left = (hoverX / width) * stageWidth;
      tooltip.style.left = `${Math.min(Math.max(8, left + 10), stageWidth - tooltip.offsetWidth - 8)}px`;
      tooltip.style.top = "20px";
    });

    hitbox.addEventListener("pointerleave", () => {
      hoverLines.forEach((line) => {
        line.style.opacity = "0";
      });
      tooltip.hidden = true;
    });
  }

  function renderMovers() {
    const ranked = activeUniverse()
      .map((stock) => ({ stock, ...performance(stock, state.moversPeriod) }))
      .filter((item) => Number.isFinite(item.percent))
      .sort((a, b) => b.percent - a.percent);
    const gainers = ranked.filter((item) => item.percent >= 0).slice(0, 50);
    const losers = ranked
      .filter((item) => item.percent < 0)
      .slice(-50)
      .reverse();
    renderMoverPage("gainers", els.gainers, els.gainersPagination, els.gainersRange, gainers);
    renderMoverPage("losers", els.losers, els.losersPagination, els.losersRange, losers);
  }

  function renderMoverPage(type, container, pagination, rangeLabel, rows) {
    const page = state.moverPages[type];
    const start = (page - 1) * 10;
    rangeLabel.textContent = rows.length
      ? `${start + 1}–${Math.min(start + 10, rows.length)} of ${rows.length}`
      : "0 of 0";
    renderMoverTable(container, rows.slice(start, start + 10), start);
    renderPagination(type, pagination, Math.ceil(rows.length / 10));
  }

  function renderMoverTable(container, rows, rankOffset) {
    container.innerHTML = `
      <div class="mover-table-head">
        <span>Ticker</span><span>Name / Index</span><span>Last</span><span>Chg %</span>
      </div>
      ${rows
        .map(
          (item, index) => `
          <button class="mover-row" data-add="${item.stock.ticker}">
            <span class="mover-ticker">
              <i class="mover-rank">${String(rankOffset + index + 1).padStart(2, "0")}</i>
              ${item.stock.ticker}
            </span>
            <span class="mover-name">${escapeHtml(item.stock.name)} · ${item.stock.indexes.length === 2 ? "Both" : item.stock.indexes[0]}</span>
            <span class="mover-last">${formatPrice(item.current)}</span>
            <span class="mover-percent ${item.percent >= 0 ? "positive" : "negative"}">${formatPercent(item.percent)}</span>
          </button>`,
        )
        .join("")}`;
  }

  function renderPagination(type, container, pageCount) {
    pageCount = Math.max(1, pageCount);
    const current = state.moverPages[type];
    container.innerHTML = `
      <button class="page-arrow" data-page-type="${type}" data-page="${current - 1}" ${current === 1 ? "disabled" : ""} aria-label="Previous ${type} page">←</button>
      <div class="page-numbers">
        ${Array.from({ length: pageCount }, (_, index) => index + 1)
          .map(
            (page) => `
              <button data-page-type="${type}" data-page="${page}" ${page === current ? 'class="active" aria-current="page"' : ""}>
                ${page}
              </button>`,
          )
          .join("")}
      </div>
      <button class="page-arrow" data-page-type="${type}" data-page="${current + 1}" ${current === pageCount ? "disabled" : ""} aria-label="Next ${type} page">→</button>`;
  }

  function comparisonExportRows() {
    return state.selected
      .map((ticker) => stockMap.get(ticker))
      .filter(Boolean)
      .map((stock) => {
        const daily = performance(stock, "1D");
        const ytd = performance(stock, "YTD");
        const mtd = performance(stock, "MTD");
        return {
          Ticker: stock.ticker,
          Name: stock.name,
          Index: stock.indexes.length === 2 ? "Both" : stock.indexes[0],
          Sector: stock.sector,
          "GICS Sub-Industry": subIndustryFor(stock),
          "Last Price": ytd.current,
          "1D Change %": daily.percent / 100,
          "YTD Change %": ytd.percent / 100,
          "MTD Change %": mtd.percent / 100,
        };
      });
  }

  function moverExportRows(type) {
    const ranked = activeUniverse()
      .map((stock) => ({ stock, ...performance(stock, state.moversPeriod) }))
      .filter((item) => Number.isFinite(item.percent))
      .sort((a, b) => b.percent - a.percent);
    const rows =
      type === "gainers"
        ? ranked.filter((item) => item.percent >= 0).slice(0, 50)
        : ranked
            .filter((item) => item.percent < 0)
            .slice(-50)
            .reverse();
    return rows.map((item, index) => ({
      Rank: index + 1,
      Ticker: item.stock.ticker,
      Name: item.stock.name,
      Index: item.stock.indexes.length === 2 ? "Both" : item.stock.indexes[0],
      Sector: item.stock.sector,
      "GICS Sub-Industry": subIndustryFor(item.stock),
      "Last Price": item.current,
      [`${state.moversPeriod} Change %`]: item.percent / 100,
    }));
  }

  function exportRows(kind) {
    return kind === "comparison" ? comparisonExportRows() : moverExportRows(kind);
  }

  const csvCell = (value) => {
    if (value == null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv(rows, filename) {
    if (!rows.length) return showToast("Nothing to export");
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.map(csvCell).join(","),
      ...rows.map((row) =>
        headers
          .map((header) => csvCell(typeof row[header] === "number" ? row[header].toString() : row[header]))
          .join(","),
      ),
    ].join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
  }

  const xmlCell = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  function columnName(index) {
    let name = "";
    let value = index + 1;
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - remainder) / 26);
    }
    return name;
  }

  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ -1) >>> 0;
  }

  const u16 = (value) => [value & 255, (value >>> 8) & 255];
  const u32 = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];

  function zipFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const contentBytes = encoder.encode(file.content);
      const crc = crc32(contentBytes);
      const localHeader = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(contentBytes.length), ...u32(contentBytes.length),
        ...u16(nameBytes.length), ...u16(0),
      ]);
      localParts.push(localHeader, nameBytes, contentBytes);
      centralParts.push(
        new Uint8Array([
          ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
          ...u32(crc), ...u32(contentBytes.length), ...u32(contentBytes.length),
          ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
        ]),
        nameBytes,
      );
      offset += localHeader.length + nameBytes.length + contentBytes.length;
    });
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(offset), ...u16(0),
    ]);
    return new Blob([...localParts, ...centralParts, end], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  function exportXlsx(rows, filename) {
    if (!rows.length) return showToast("Nothing to export");
    const headers = Object.keys(rows[0]);
    const sheetRows = [headers, ...rows.map((row) => headers.map((header) => row[header]))]
      .map(
        (cells, rowIndex) =>
          `<row r="${rowIndex + 1}">${cells
            .map((value, colIndex) => {
              const ref = `${columnName(colIndex)}${rowIndex + 1}`;
              return typeof value === "number"
                ? `<c r="${ref}"><v>${value}</v></c>`
                : `<c r="${ref}" t="inlineStr"><is><t>${xmlCell(value)}</t></is></c>`;
            })
            .join("")}</row>`,
      )
      .join("");
    const files = [
      {
        name: "[Content_Types].xml",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      },
      {
        name: "_rels/.rels",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      },
      {
        name: "xl/workbook.xml",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
      },
    ];
    downloadBlob(zipFiles(files), filename);
  }

  function handleExport(kind, format) {
    const rows = exportRows(kind);
    const suffix = kind === "comparison" ? state.chartPeriod.toLowerCase() : state.moversPeriod.toLowerCase();
    const filename = `market-movers-${kind}-${suffix}.${format}`;
    if (format === "csv") exportCsv(rows, filename);
    else exportXlsx(rows, filename);
  }

  function renderComparison() {
    renderSelected();
    renderSummary();
    renderChart();
  }

  function filteredSearchResults() {
    const query = els.search.value.trim().toLowerCase();
    return activeUniverse()
      .filter(
        (stock) =>
          !query ||
          stock.ticker.toLowerCase().includes(query) ||
          stock.name.toLowerCase().includes(query),
      )
      .slice(0, 12);
  }

  function renderSearch() {
    const matches = filteredSearchResults();
    els.results.innerHTML = matches.length
      ? matches
          .map(
            (stock) => `
              <button class="search-result" data-add="${stock.ticker}">
                <strong>${stock.ticker}</strong>
                <span class="company-name">${escapeHtml(stock.name)}</span>
                <span class="membership">${membershipHtml(stock)}</span>
              </button>`,
          )
          .join("")
      : '<div class="search-result"><span></span><span class="company-name">No matches found</span></div>';
    els.results.hidden = false;
    els.search.setAttribute("aria-expanded", "true");
  }

  function closeSearch() {
    els.results.hidden = true;
    els.search.setAttribute("aria-expanded", "false");
  }

  document.addEventListener("click", (event) => {
    const addTarget = event.target.closest("[data-add]");
    const removeTarget = event.target.closest("[data-remove]");
    const pageTarget = event.target.closest("[data-page-type]");
    const subIndustryTarget = event.target.closest("[data-sub-industry]");
    const sectorTarget = event.target.closest("[data-sector]");
    const exportTarget = event.target.closest("[data-export]");
    if (exportTarget) {
      handleExport(exportTarget.dataset.export, exportTarget.dataset.format);
    }
    if (pageTarget && !pageTarget.disabled) {
      state.moverPages[pageTarget.dataset.pageType] = Number(pageTarget.dataset.page);
      renderMovers();
    }
    if (subIndustryTarget) {
      state.sector = subIndustryTarget.dataset.sectorName;
      state.subIndustry = subIndustryTarget.dataset.subIndustry;
      state.moverPages = { gainers: 1, losers: 1 };
      renderSectorFilters();
      renderSubIndustryFilter();
      updateUniverseLabels();
      renderMovers();
      if (!els.results.hidden) renderSearch();
    } else if (sectorTarget) {
      state.sector = sectorTarget.dataset.sector;
      state.subIndustry = "all";
      state.moverPages = { gainers: 1, losers: 1 };
      renderSectorFilters();
      renderSubIndustryFilter();
      updateUniverseLabels();
      renderMovers();
      if (!els.results.hidden) renderSearch();
    }
    if (addTarget) addStock(addTarget.dataset.add);
    if (removeTarget) removeStock(removeTarget.dataset.remove);
    if (!event.target.closest(".search-box")) closeSearch();
  });

  els.search.addEventListener("input", renderSearch);
  els.search.addEventListener("focus", renderSearch);
  els.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearch();
    if (event.key === "Enter") {
      const first = els.results.querySelector("[data-add]");
      if (first) addStock(first.dataset.add);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== els.search) {
      event.preventDefault();
      els.search.focus();
    }
  });

  document.querySelector("#clearSector").addEventListener("click", () => {
    state.sector = "all";
    state.subIndustry = "all";
    state.moverPages = { gainers: 1, losers: 1 };
    renderSectorFilters();
    renderSubIndustryFilter();
    updateUniverseLabels();
    renderMovers();
    if (!els.results.hidden) renderSearch();
  });

  document.querySelectorAll(".chart-view-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".chart-view-toggle button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.chartView = button.dataset.view;
      renderChart();
    });
  });

  document.querySelectorAll(".chart-period-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".chart-period-toggle button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.chartPeriod = button.dataset.period;
      renderChart();
    });
  });

  document.querySelectorAll(".metric-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".metric-toggle button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.chartMetric = button.dataset.metric;
      renderChart();
    });
  });

  document.querySelectorAll(".movers-period-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".movers-period-toggle button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.moversPeriod = button.dataset.period;
      state.moverPages = { gainers: 1, losers: 1 };
      renderMovers();
    });
  });

  setUniverseCounts();
  renderComparison();
  renderMovers();
  refreshLivePrices();
  setInterval(refreshLivePrices, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshLivePrices();
  });
})();
