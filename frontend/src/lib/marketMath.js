/**
 * Client-side derivations from genuine backend price data.
 * Every function here is a transparent mathematical transform of OHLCV
 * rows returned by GET /datasets/{id}/prices — no invented values.
 *
 * rows: [{ date, open, high, low, close, volume }]
 */

const TRADING_DAYS = 252;

export function toCloses(rows) {
  return (rows || []).map((r) => ({
    date: String(r.date).slice(0, 10),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/** Daily simple returns aligned to dates[i>=1]. */
export function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1].close;
    if (prev > 0) {
      out.push({ date: closes[i].date, ret: closes[i].close / prev - 1 });
    }
  }
  return out;
}

function mean(xs) {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

export function rollingStdDev(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i += 1) {
    out[i] = stdev(values.slice(i - window + 1, i + 1));
  }
  return out;
}

export function rollingMean(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i += 1) {
    out[i] = mean(values.slice(i - window + 1, i + 1));
  }
  return out;
}

/** Drawdown series vs running peak. */
export function drawdownSeries(closes) {
  let peak = -Infinity;
  return closes.map((c) => {
    peak = Math.max(peak, c.close);
    return peak > 0 ? c.close / peak - 1 : 0;
  });
}

/** Momentum over k trading days: close_t / close_{t-k} - 1 */
export function momentum(closes, k) {
  const out = new Array(closes.length).fill(null);
  for (let i = k; i < closes.length; i += 1) {
    if (closes[i - k].close > 0) {
      out[i] = closes[i].close / closes[i - k].close - 1;
    }
  }
  return out;
}

/**
 * Full derived frame used by Overview overlays and heatmaps.
 * Returns { dates, closes, returns, vol20Annualized[], drawdown[], mom20[], ma20[] }
 */
export function buildDerivedFrame(rows) {
  const closes = toCloses(rows);
  const dates = closes.map((c) => c.date);
  const priceSeries = closes.map((c) => c.close);
  const rets = dailyReturns(closes).map((r) => r.ret);
  // Align returns to dates[1..]
  const retAligned = new Array(dates.length).fill(null);
  for (let i = 0; i < rets.length; i += 1) retAligned[i + 1] = rets[i];
  const volDaily = rollingStdDev(rets, 20);
  const vol20 = new Array(dates.length).fill(null);
  for (let i = 0; i < volDaily.length; i += 1) {
    vol20[i + 1] =
      typeof volDaily[i] === "number" ? volDaily[i] * Math.sqrt(TRADING_DAYS) : null;
  }
  return {
    dates,
    closes: priceSeries,
    volumes: closes.map((c) => c.volume),
    returns: retAligned,
    vol20,
    drawdown: drawdownSeries(closes),
    mom20: momentum(closes, 20),
    mom60: momentum(closes, 60),
    ma20: (() => {
      const m = rollingMean(priceSeries, 20);
      return new Array(dates.length).fill(null).map((_, i) => m[i]);
    })(),
  };
}

/** Percentile rank of `value` within `series` ignoring nulls (0-100). */
export function percentileRank(series, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const clean = series.filter(
    (x) => x !== null && x !== undefined && Number.isFinite(x),
  );
  if (clean.length < 2) return null;
  let below = 0;
  for (const x of clean) if (x <= value) below += 1;
  return (below / clean.length) * 100;
}

/** Forward return over k days ending at index i (close[i+k]/close[i]-1). */
export function forwardReturn(closes, i, k) {
  if (i < 0 || i + k >= closes.length) return null;
  if (closes[i] <= 0) return null;
  return closes[i + k] / closes[i] - 1;
}
