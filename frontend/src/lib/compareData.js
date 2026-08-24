import {
  formatConfidence,
  formatDateRange,
  formatInteger,
  formatNumber,
  formatPercent,
  formatPrice,
  formatSignedPercent,
} from "./format.js";

/**
 * Builds the quantitative comparison matrix rows from already-fetched
 * endpoint payloads. Pure presentation mapping — no analytics are
 * recomputed; every metric is taken from a backend field, except total
 * return which is the trivial first→last close ratio over stored prices.
 */
export function buildComparisonRows(datasets, dataByPath) {
  return datasets.map((dataset) => {
    const id = dataset.id;
    const fp = dataByPath.get(`/datasets/${id}/fingerprint`)?.fingerprint ?? {};
    const regime = dataByPath.get(`/datasets/${id}/regimes/current`)?.current_regime ?? {};
    const summary = dataByPath.get(`/datasets/${id}/intelligence/summary`) ?? {};
    const priceRows = dataByPath.get(`/datasets/${id}/prices`)?.prices ?? [];

    const firstClose = priceRows.length > 0 ? priceRows[0].close : null;
    const lastClose =
      priceRows.length > 0 ? priceRows[priceRows.length - 1].close : null;
    const totalReturn =
      firstClose && lastClose ? lastClose / firstClose - 1 : null;

    return { dataset, fp, regime, summary, priceRows, totalReturn };
  });
}

export function matrixMetricDefinitions() {
  return [
    { key: "range", group: "Coverage", label: "Date range", value: (r) => formatDateRange(r.dataset.start_date, r.dataset.end_date), raw: (r) => `${r.dataset.start_date} to ${r.dataset.end_date}` },
    { key: "rows", group: "Coverage", label: "Row count", value: (r) => formatInteger(r.dataset.row_count), raw: (r) => r.dataset.row_count },
    { key: "close", group: "Coverage", label: "Latest close", value: (r) => formatPrice(r.dataset.latest_close), raw: (r) => r.dataset.latest_close },
    { key: "total", group: "Returns", label: "Total return", value: (r) => formatSignedPercent(r.totalReturn), raw: (r) => r.totalReturn },
    { key: "mean_daily", group: "Returns", label: "Mean daily return", value: (r) => formatSignedPercent(r.fp.mean_daily_return), raw: (r) => r.fp.mean_daily_return },
    { key: "mom20", group: "Returns", label: "Momentum 20d", value: (r) => formatSignedPercent(r.fp.momentum_20), raw: (r) => r.fp.momentum_20 },
    { key: "mom60", group: "Returns", label: "Momentum 60d", value: (r) => formatSignedPercent(r.fp.momentum_60), raw: (r) => r.fp.momentum_60 },
    { key: "vol", group: "Risk", label: "Annualized volatility", value: (r) => formatPercent(r.fp.annualized_volatility), raw: (r) => r.fp.annualized_volatility },
    { key: "maxdd", group: "Risk", label: "Maximum drawdown", value: (r) => formatSignedPercent(r.fp.max_drawdown), raw: (r) => r.fp.max_drawdown },
    { key: "skew", group: "Distribution", label: "Skewness", value: (r) => formatNumber(r.fp.skewness, 3), raw: (r) => r.fp.skewness },
    { key: "kurt", group: "Distribution", label: "Excess kurtosis", value: (r) => formatNumber(r.fp.kurtosis, 3), raw: (r) => r.fp.kurtosis },
    { key: "regime", group: "Regime", label: "Current regime", value: (r) => r.regime.label ?? "N/A", raw: (r) => r.regime.label ?? "" },
    { key: "bias", group: "Intelligence", label: "Directional bias", value: (r) => upper(r.summary.directional_bias), raw: (r) => r.summary.directional_bias ?? "" },
    { key: "risk", group: "Intelligence", label: "Risk level", value: (r) => upper(r.summary.risk_level), raw: (r) => r.summary.risk_level ?? "" },
    { key: "confidence", group: "Intelligence", label: "Intelligence confidence", value: (r) => formatConfidence(r.summary.confidence), raw: (r) => r.summary.confidence },
    { key: "agreement", group: "Intelligence", label: "Analogue agreement", value: (r) => upper(r.summary.analogue_agreement), raw: (r) => r.summary.analogue_agreement ?? "" },
    { key: "trend", group: "States", label: "Trend state", value: (r) => upper(r.summary.trend_state), raw: (r) => r.summary.trend_state ?? "" },
    { key: "volstate", group: "States", label: "Volatility state", value: (r) => upper(r.summary.volatility_state), raw: (r) => r.summary.volatility_state ?? "" },
  ];
}

function upper(value) {
  return value === null || value === undefined || value === "" ? "N/A" : String(value).toUpperCase();
}

export function fingerprintCsvRows(fingerprint) {
  const entries = Object.entries(fingerprint ?? {}).filter(
    ([, value]) => typeof value === "number" || value === null,
  );
  return entries.map(([metric, value]) => ({ metric, value }));
}

export function analogueCsvRows(analogues) {
  return (analogues ?? []).map((analogue) => ({
    rank: analogue.rank,
    start_date: analogue.start_date,
    end_date: analogue.end_date,
    distance: analogue.distance,
    similarity_score: analogue.similarity_score,
    ...Object.fromEntries(
      Object.entries(analogue.characteristics ?? {}).map(([key, value]) => [key, value]),
    ),
    forward_available: analogue.subsequent_market_action?.available ? "yes" : "no",
    return_after_5_days: analogue.subsequent_market_action?.return_after_5_days,
    return_after_10_days: analogue.subsequent_market_action?.return_after_10_days,
    return_after_20_days: analogue.subsequent_market_action?.return_after_20_days,
    max_favourable_move_20d: analogue.subsequent_market_action?.max_favourable_move_20d,
    max_adverse_move_20d: analogue.subsequent_market_action?.max_adverse_move_20d,
  }));
}

export function timelineCsvRows(regimesPayload) {
  return (regimesPayload?.timeline ?? []).map((entry) => ({
    start_date: entry.start_date,
    end_date: entry.end_date,
    window_end_index: entry.window_end_index,
    regime_id: entry.regime_id,
    regime_label: entry.regime_label,
    pc1: entry.pca_coordinates?.[0],
    pc2: entry.pca_coordinates?.[1],
    distance_to_centroid: entry.distance_to_centroid,
    confidence: entry.confidence,
  }));
}
