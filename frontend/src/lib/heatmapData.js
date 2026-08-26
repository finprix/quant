/**
 * Heatmap computation over genuine FINPRIX price data.
 * All values derive from GET /datasets/{id}/prices (client-side transforms)
 * or from backend regime/analogue payloads — nothing is invented.
 */

import { buildDerivedFrame, percentileRank, forwardReturn } from "./marketMath.js";

/** Signed diverging color: negative → burgundy ramp, positive → sage ramp. */
export function signedColor(fraction) {
  // fraction in [-1, 1]
  const f = Math.max(-1, Math.min(1, fraction ?? 0));
  if (f < 0) {
    const t = -f;
    return `rgba(112, 22, 38, ${0.15 + 0.8 * t})`;
  }
  const t = f;
  return `rgba(95, 125, 90, ${0.12 + 0.75 * t})`;
}

/** Magnitude-only color (burgundy intensity). */
export function magnitudeColor(fraction) {
  const t = Math.max(0, Math.min(1, fraction ?? 0));
  return `rgba(166, 43, 61, ${0.08 + 0.85 * t})`;
}

function bucketSeries(values, buckets) {
  const n = values.length;
  if (n === 0) return [];
  const size = Math.max(1, Math.ceil(n / buckets));
  const out = [];
  for (let b = 0; b < n; b += size) {
    let sum = 0;
    let count = 0;
    for (let i = b; i < Math.min(b + size, n); i += 1) {
      const v = values[i];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
    }
    out.push(count ? sum / count : null);
  }
  return out;
}

/**
 * Layer A — Time × Metric matrix.
 * rows: metric definitions; each cell = percentile of the bucket mean
 * within that metric's own distribution (signed metrics split at median).
 */
export function buildTimeMetricMatrix(rows, { buckets = 60 } = {}) {
  const frame = buildDerivedFrame(rows);
  void frame.ma20;
  const closes = rows.map((r) => Number(r.close));
  const defs = [
    {
      key: "returns",
      label: "RETURNS",
      series: frame.returns,
      signed: true,
    },
    {
      key: "momentum",
      label: "MOMENTUM 20D",
      series: frame.mom20,
      signed: true,
    },
    {
      key: "trend",
      label: "TREND (MA20 GAP)",
      series: closes.map((c, i) =>
        frame.ma20[i] ? c / frame.ma20[i] - 1 : null,
      ),
      signed: true,
    },
    {
      key: "volatility",
      label: "VOLATILITY 20D",
      series: frame.vol20,
      signed: false,
    },
    {
      key: "drawdown",
      label: "DRAWDOWN",
      series: frame.drawdown,
      signed: false,
    },
    {
      key: "volume",
      label: "VOLUME (rel.)",
      series: (() => {
        const vols = rows.map((r) => Number(r.volume));
        const avg = vols.reduce((a, v) => a + v, 0) / (vols.length || 1);
        return vols.map((v) => (avg > 0 ? v / avg : null));
      })(),
      signed: false,
    },
  ];

  const dateBuckets = [];
  {
    const dates = frame.dates;
    const size = Math.max(1, Math.ceil(dates.length / buckets));
    for (let b = 0; b < dates.length; b += size) {
      dateBuckets.push(dates[Math.min(b + size - 1, dates.length - 1)]);
    }
  }

  const gridRows = defs.map((def) => {
    const bucketMeans = bucketSeries(def.series, buckets);
    const clean = bucketMeans.filter((v) => v != null && Number.isFinite(v));
    const cells = bucketMeans.map((v) => {
      if (v == null || !Number.isFinite(v)) {
        return { raw: null, pct: null };
      }
      const p = percentileRank(clean, v); // 0..100
      return {
        raw: v,
        // signed metrics: center at 50th percentile; magnitude metrics: raw rank
        display: def.signed ? (p - 50) / 50 : p / 100 - 0.35,
      };
    });
    return { ...def, cells };
  });

  return { columnLabels: dateBuckets, rows: gridRows };
}

/**
 * Layer B — Forward-return horizon heatmap.
 * Cell = percentile of median forward return within that horizon's row.
 */
export function buildHorizonMatrix(rows, { buckets = 40 } = {}) {
  const closes = rows.map((r) => Number(r.close));
  const horizons = [1, 5, 10, 20, 60];
  const step = Math.max(1, Math.floor(closes.length / buckets));

  const gridRows = horizons.map((h) => {
    const cells = [];
    for (let i = 0; i < closes.length; i += step) {
      const fwd = forwardReturn(closes, i, h);
      cells.push({ index: i, raw: fwd });
    }
    const clean = cells.filter((c) => c.raw != null).map((c) => c.raw);
    return {
      key: `fwd${h}`,
      label: `${h}D FWD`,
      cells: cells.map((c) => {
        if (c.raw == null || !clean.length) return { raw: null, display: null };
        const p = percentileRank(clean, c.raw);
        return { raw: c.raw, display: (p - 50) / 50 };
      }),
    };
  });

  return { columnLabels: null, rows: gridRows, columns: null };
}

/**
 * Layer C — Regime × characteristic heatmap from the regimes payload.
 */
export function buildRegimeMatrix(regimesPayload) {
  const regimes = regimesPayload?.regimes ?? [];
  const transitions = regimesPayload?.transitions;
  const diag = new Map();
  if (transitions?.probabilities && transitions?.regime_ids) {
    transitions.regime_ids.forEach((id, i) => diag.set(id, transitions.probabilities[i]?.[i] ?? null));
  }

  const cols = [
    { key: "occupancy", label: "OCCUPANCY", get: (r, ctx) => (ctx.total ? r.window_count / ctx.total : null), fmt: (v) => `${Math.round(v * 100)}%` },
    { key: "vol", label: "VOLATILITY", get: (r) => r.volatility, fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { key: "mdd", label: "MAX DD", get: (r) => r.max_drawdown, fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { key: "mom", label: "MOM 20D", get: (r) => r.avg_momentum_20, fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { key: "f5", label: "FWD 5D", get: (r) => r.forward_outcomes?.avg_return_after_5_days, fmt: (v) => `${(v * 100).toFixed(2)}%`, signed: true },
    { key: "f10", label: "FWD 10D", get: (r) => r.forward_outcomes?.avg_return_after_10_days, fmt: (v) => `${(v * 100).toFixed(2)}%`, signed: true },
    { key: "f20", label: "FWD 20D MED", get: (r) => r.forward_outcomes?.median_return_after_20_days, fmt: (v) => `${(v * 100).toFixed(2)}%`, signed: true },
    { key: "p20", label: "P(F20>0)", get: (r) => r.forward_outcomes?.probability_positive_after_20_days, fmt: (v) => `${Math.round(v * 100)}%`, signed: true },
    { key: "persist", label: "PERSISTENCE", get: (r) => diag.get(r.regime_id) ?? null, fmt: (v) => `${Math.round(v * 100)}%`, signed: true },
  ];

  const total = regimes.reduce((a, r) => a + (r.window_count ?? 0), 0);

  const rowsOut = regimes.map((r) => ({
    label: `R${String(r.regime_id + 1).padStart(2, "0")} · ${r.label ?? ""}`,
    cells: cols.map((c) => {
      const raw = c.get(r, { total });
      return {
        raw,
        display:
          raw == null || !Number.isFinite(raw)
            ? null
            : c.signed
              ? Math.max(-1, Math.min(1, raw * 2))
              : Math.min(1, Math.abs(raw)),
        signed: Boolean(c.signed),
      };
    }),
  }));

  return { columnLabels: cols.map((c) => c.label), rows: rowsOut, formatters: Object.fromEntries(cols.map((c) => [c.key, c.fmt])) , cols };
}

/**
 * Layer D — Analogue outcome heatmap.
 */
export function buildAnalogueMatrix(analoguesPayload) {
  const matches = analoguesPayload?.analogues ?? [];
  const cols = [
    { key: "sim", label: "MATCH SCORE", get: (m) => m.similarity_score, fmt: (v) => `${(v * 100).toFixed(1)}%`, signed: true },
    { key: "f5", label: "5D AFTER", get: (m) => m.subsequent_market_action?.return_after_5_days, fmt: (v) => `${(v * 100).toFixed(2)}%`, signed: true },
    { key: "f10", label: "10D AFTER", get: (m) => m.subsequent_market_action?.return_after_10_days, fmt: (v) => `${(v * 100).toFixed(2)}%`, signed: true },
    { key: "f20", label: "20D AFTER", get: (m) => m.subsequent_market_action?.return_after_20_days, fmt: (v) => `${(v * 100).toFixed(2)}%`, signed: true },
    { key: "fav", label: "MAX FAV 20D", get: (m) => m.subsequent_market_action?.max_favourable_move_20d, fmt: (v) => `${(v * 100).toFixed(1)}%`, signed: true },
    { key: "adv", label: "MAX ADV 20D", get: (m) => m.subsequent_market_action?.max_adverse_move_20d, fmt: (v) => `${(v * 100).toFixed(1)}%`, signed: true },
    { key: "vol", label: "WINDOW VOL", get: (m) => m.characteristics?.annualized_volatility, fmt: (v) => `${(v * 100).toFixed(1)}%`, signed: false },
    { key: "dd", label: "WINDOW MAXDD", get: (m) => m.characteristics?.max_drawdown, fmt: (v) => `${(v * 100).toFixed(1)}%`, signed: true },
  ];

  const rowsOut = matches.map((m) => ({
    label: `#${String(m.rank).padStart(2, "0")} · ${String(m.start_date).slice(0, 7)} → ${String(m.end_date).slice(0, 7)}`,
    detail: m,
    cells: cols.map((c) => {
      const raw = c.get(m);
      return {
        raw,
        display:
          raw == null || !Number.isFinite(raw)
            ? null
            : c.signed
              ? Math.max(-1, Math.min(1, raw * 4))
              : Math.min(1, raw),
        signed: Boolean(c.signed),
      };
    }),
  }));

  return { columnLabels: cols.map((c) => c.label), rows: rowsOut, cols };
}
