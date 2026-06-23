(() => {
  "use strict";

  const data = window.MARKET_DATA;
  if (!data?.stocks?.length) {
    document.body.innerHTML = "<p>Market data could not be loaded.</p>";
    return;
  }
  const snapshotAsOf = data.asOf;

  const colors = [
    "#6256d9",
    "#e95f3d",
    "#16865c",
    "#d23d8f",
    "#3c82d0",
    "#a27322",
    "#7956a8",
    "#2e9cab",
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
    subIndustryFilter: document.querySelector("#subIndustryFilter"),
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
    els.sectorFilters.innerHTML = [
      `<button class="sector-filter ${state.sector === "all" ? "active" : ""}" data-sector="all">
        <span>All sectors</span><span class="sector-filter-count">${data.stocks.length}</span>
      </button>`,
      ...sectorOrder.map(
        (sector) => `
          <button class="sector-filter ${state.sector === sector ? "active" : ""}" data-sector="${sector}">
            <span>${sector}</span><span class="sector-filter-count">${counts.get(sector)}</span>
          </button>`,
      ),
    ].join("");
  }

  function renderSubIndustryFilter() {
    if (!els.subIndustryFilter) return;
    const candidates = data.stocks.filter(
      (stock) => state.sector === "all" || stock.sector === state.sector,
    );
    const subIndustries = [...new Set(candidates.map(subIndustryFor).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b),
    );
    if (!subIndustries.length) {
      state.subIndustry = "all";
      els.subIndustryFilter.disabled = true;
      els.subIndustryFilter.innerHTML =
        '<option value="all">No official sub-industry source loaded</option>';
      if (els.classificationNote) {
        els.classificationNote.textContent =
          "Sector filter is active. Sub-Industry needs a company-level GICS source.";
      }
      return;
    }
    if (state.subIndustry !== "all" && !subIndustries.includes(state.subIndustry)) {
      state.subIndustry = "all";
    }
    els.subIndustryFilter.disabled = false;
    els.subIndustryFilter.innerHTML = [
      `<option value="all">All sub-industries</option>`,
      ...subIndustries.map(
        (subIndustry) =>
          `<option value="${escapeHtml(subIndustry)}" ${state.subIndustry === subIndustry ? "selected" : ""}>${escapeHtml(subIndustry)}</option>`,
      ),
    ].join("");
    if (els.classificationNote) {
      const meta = window.GICS_SUB_INDUSTRIES_META;
      els.classificationNote.textContent = meta
        ? `${meta.matchedTickers} of ${meta.universeTickers} tickers mapped from Capital IQ primary industry.`
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

  function applyLiveQuotes(payload) {
    let updated = 0;
    let latestDate = data.asOf;
    Object.entries(payload.quotes || {}).forEach(([ticker, quote]) => {
      const stock = stockMap.get(ticker);
      if (!stock) return;
      if (quote.previousDate && Number.isFinite(quote.previousClose)) {
        mergePricePoint(stock, quote.previousDate, quote.previousClose);
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
        <span>YTD Chg %</span><span>MTD Chg %</span>
      </div>
      ${state.selected
        .map((ticker, index) => {
          const stock = stockMap.get(ticker);
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

  function renderChart() {
    const period = state.chartPeriod;
    const svg = document.querySelector("#chartMain");
    const legend = document.querySelector("#legendMain");
    const tooltip = document.querySelector("#tooltipMain");
    const metric = state.chartMetric;
    const selectedStocks = state.selected.map((ticker) => stockMap.get(ticker));
    const isYtd = period === "YTD";
    document.querySelector("#chartKicker").textContent = isYtd ? "From Dec 31 close" : "From prior month close";
    document.querySelector("#chartTitle").textContent = isYtd ? "Year to date" : "Month to date";
    svg.setAttribute("aria-label", `${isYtd ? "Year-to-date" : "Month-to-date"} price chart`);
    svg.replaceChildren();

    if (!selectedStocks.length) {
      svg.setAttribute("viewBox", "0 0 1200 360");
      const text = svgNode("text", {
        x: 600,
        y: 180,
        "text-anchor": "middle",
        class: "axis-label",
      });
      text.textContent = "Search for a stock to begin";
      svg.append(text);
      legend.innerHTML = "";
      return;
    }

    const width = 1200;
    const height = 360;
    const margin = { top: 18, right: 18, bottom: 32, left: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const series = selectedStocks.map((stock) => {
      const raw = periodSeries(stock, period);
      const base = raw[0][1];
      return raw.map(([date, price]) => ({
        date,
        time: new Date(`${date}T12:00:00`).getTime(),
        raw: price,
        value: metric === "percent" ? ((price / base) - 1) * 100 : price,
      }));
    });

    const allPoints = series.flat();
    const minTime = Math.min(...allPoints.map((point) => point.time));
    const maxTime = Math.max(...allPoints.map((point) => point.time));
    const observedMin = Math.min(...allPoints.map((point) => point.value));
    const observedMax = Math.max(...allPoints.map((point) => point.value));
    const percentScale =
      metric === "percent" ? nicePercentScale(observedMin, observedMax) : null;
    const [minValue, maxValue] = percentScale
      ? [percentScale.min, percentScale.max]
      : niceExtent(observedMin, observedMax, metric);
    const x = (time) => margin.left + ((time - minTime) / (maxTime - minTime || 1)) * plotWidth;
    const y = (value) => margin.top + (1 - (value - minValue) / (maxValue - minValue || 1)) * plotHeight;

    const axisTicks = percentScale
      ? percentScale.ticks
      : Array.from(
          { length: 5 },
          (_, index) => minValue + ((maxValue - minValue) * index) / 4,
        );
    for (const value of axisTicks) {
      const yPos = y(value);
      const line = svgNode("line", {
        x1: margin.left,
        y1: yPos,
        x2: width - margin.right,
        y2: yPos,
        class: `grid-line ${metric === "percent" && value === 0 ? "zero-line" : ""}`,
      });
      const label = svgNode("text", {
        x: margin.left - 8,
        y: yPos + 3,
        "text-anchor": "end",
        class: "axis-label",
      });
      const percentDecimals = percentScale && percentScale.step < 1 ? 1 : 0;
      label.textContent =
        metric === "percent"
          ? `${value.toFixed(percentDecimals)}%`
          : `$${value.toFixed(0)}`;
      svg.append(line, label);
    }

    const dateTicks = 4;
    for (let index = 0; index < dateTicks; index += 1) {
      const time = minTime + ((maxTime - minTime) * index) / (dateTicks - 1);
      const xPos = x(time);
      const label = svgNode("text", {
        x: xPos,
        y: height - 8,
        "text-anchor": index === 0 ? "start" : index === dateTicks - 1 ? "end" : "middle",
        class: "axis-label",
      });
      label.textContent = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
      }).format(new Date(time));
      svg.append(label);
    }

    series.forEach((points, index) => {
      const pathData = points
        .map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`)
        .join(" ");
      const path = svgNode("path", {
        d: pathData,
        class: "series-path",
        style: `--series-color:${colors[index]}`,
      });
      const end = points[points.length - 1];
      const dot = svgNode("circle", {
        cx: x(end.time),
        cy: y(end.value),
        r: 4,
        class: "series-end",
        style: `--series-color:${colors[index]}`,
      });
      svg.append(path, dot);
    });

    const hoverLine = svgNode("line", {
      y1: margin.top,
      y2: height - margin.bottom,
      class: "hover-line",
    });
    const hitbox = svgNode("rect", {
      x: margin.left,
      y: margin.top,
      width: plotWidth,
      height: plotHeight,
      class: "chart-hitbox",
    });
    svg.append(hoverLine, hitbox);

    const timeline = [...new Set(allPoints.map((point) => point.time))].sort(
      (left, right) => left - right,
    );

    hitbox.addEventListener("pointermove", (event) => {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const matrix = svg.getScreenCTM();
      const svgPoint = matrix ? point.matrixTransform(matrix.inverse()) : point;
      const plotX = Math.max(margin.left, Math.min(width - margin.right, svgPoint.x));
      const targetTime =
        minTime + ((plotX - margin.left) / plotWidth) * (maxTime - minTime);
      const anchorTime = timeline.reduce((best, time) =>
        Math.abs(time - targetTime) < Math.abs(best - targetTime) ? time : best,
      );
      const rows = series.map((points, index) => {
        const nearest = points.reduce((best, point) =>
          Math.abs(point.time - anchorTime) < Math.abs(best.time - anchorTime) ? point : best,
        );
        return { stock: selectedStocks[index], point: nearest, color: colors[index] };
      });
      const anchorDate = new Date(anchorTime).toISOString().slice(0, 10);
      const hoverX = x(anchorTime);
      hoverLine.setAttribute("x1", hoverX);
      hoverLine.setAttribute("x2", hoverX);
      hoverLine.style.opacity = "0.65";
      tooltip.hidden = false;
      tooltip.innerHTML = `
        <span class="tip-date">${displayDate(anchorDate, { year: true })}</span>
        ${rows
          .map(
            ({ stock, point, color }) => `
              <span class="tip-row" style="--series-color:${color}">
                <span>${stock.ticker}</span>
                <strong>${metric === "percent" ? formatPercent(point.value) : formatPrice(point.raw)}</strong>
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
      hoverLine.style.opacity = "0";
      tooltip.hidden = true;
    });

    legend.innerHTML = selectedStocks
      .map((stock, index) => {
        const move = performance(stock, period);
        return `
          <button class="legend-item" data-remove="${stock.ticker}" style="--series-color:${colors[index]}">
            <span class="color-dot"></span>
            ${stock.ticker}
            <span class="${move.percent >= 0 ? "positive" : "negative"}">${formatPercent(move.percent)}</span>
          </button>`;
      })
      .join("");
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
    const sectorTarget = event.target.closest("[data-sector]");
    if (pageTarget && !pageTarget.disabled) {
      state.moverPages[pageTarget.dataset.pageType] = Number(pageTarget.dataset.page);
      renderMovers();
    }
    if (sectorTarget) {
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

  els.subIndustryFilter?.addEventListener("change", () => {
    state.subIndustry = els.subIndustryFilter.value;
    state.moverPages = { gainers: 1, losers: 1 };
    updateUniverseLabels();
    renderMovers();
    if (!els.results.hidden) renderSearch();
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
