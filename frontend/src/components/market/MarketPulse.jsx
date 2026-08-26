import { TerminalPanel } from "../common/Panels.jsx";

/**
 * FINPRIX MARKET PULSE — deterministic composite of real index data.
 *
 * Methodology (inspectable, no fabrication):
 *   breadth   = advancing share of tracked global indices      [0..100]
 *   momentum  = clamp(50 + mean(index 1D %) × 12)              [0..100]
 *   risk      = (breadth + momentum) / 2 — risk-appetite proxy [0..100]
 *   volatility= raw VIX level + categorical state (no fake /100)
 *   composite = mean of available scores -> categorical state
 * Components with missing inputs are omitted, never invented.
 */

const clamp01 = (v) => Math.max(0, Math.min(100, Math.round(v)));

function buildPulse(quotes) {
  const indices = quotes.filter(
    (q) => q.group === "index" && q.quote && q.quote.change_percent != null,
  );
  if (!indices.length) return null;

  const changes = indices.map((q) => q.quote.change_percent);
  const advancers = changes.filter((c) => c > 0).length;
  const breadth = clamp01((advancers / indices.length) * 100);
  const meanChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  const momentum = clamp01(50 + meanChange * 12);
  const risk = Math.round((breadth + momentum) / 2);

  const vixRow = quotes.find(
    (q) => q.symbol === "^VIX" && q.quote && q.quote.price != null,
  );
  const vix = vixRow ? Number(vixRow.quote.price) : null;
  const volState =
    vix == null
      ? null
      : vix <= 14
        ? "LOW"
        : vix <= 20
          ? "MODERATE"
          : vix <= 28
            ? "ELEVATED"
            : "HIGH";
  const volatilityScore =
    vix == null ? null : clamp01(100 - vix * 3);

  const scores = [breadth, momentum, risk, volatilityScore].filter(
    (v) => v != null,
  );
  const composite = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null;
  const state =
    composite == null
      ? "UNAVAILABLE"
      : composite >= 62
        ? "BULLISH"
        : composite >= 55
          ? "MODERATELY BULLISH"
          : composite >= 45
            ? "MIXED"
            : composite >= 38
              ? "MODERATELY BEARISH"
              : "BEARISH";

  return {
    breadth: { value: breadth, caption: `${advancers}/${indices.length} ADVANCING` },
    momentum: { value: momentum, caption: `MEAN ${meanChange >= 0 ? "+" : ""}${meanChange.toFixed(2)}%` },
    risk: { value: risk, caption: risk >= 60 ? "RISK-ON" : risk <= 40 ? "RISK-OFF" : "NEUTRAL" },
    volatility:
      vix == null
        ? null
        : { value: volatilityScore, caption: `VIX ${vix.toFixed(1)} · ${volState}` },
    composite: { value: composite, state },
  };
}

function Gauge({ label, metric }) {
  if (!metric) return null;
  const v = metric.value;
  const tone = v >= 55 ? "pos" : v <= 40 ? "neg" : "";
  return (
    <div className="pulse-gauge">
      <div className="pulse-gauge-head">
        <span className="ctx-label">{label}</span>
        <span className={`mono pulse-score ${tone}`}>{v}</span>
      </div>
      <div className="pulse-bar">
        <div className={`pulse-bar-fill ${tone}`} style={{ width: `${Math.max(2, v)}%` }} />
      </div>
      <div className="fineprint">{metric.caption}</div>
    </div>
  );
}

export default function MarketPulse({ quotes }) {
  const pulse = quotes ? buildPulse(quotes) : null;
  return (
    <TerminalPanel
      title="FINPRIX MARKET PULSE"
      subtitle="Deterministic composite of live global index data"
    >
      {!pulse ? (
        <p className="fineprint">
          Market pulse unavailable — global index data has not loaded yet.
        </p>
      ) : (
        <div className="pulse-wrap">
          <div className="pulse-composite">
            <div className="fineprint">COMPOSITE STATE</div>
            <div
              className={`pulse-state ${
                pulse.composite.value >= 55
                  ? "pos"
                  : pulse.composite.value <= 40
                    ? "neg"
                    : ""
              }`}
            >
              {pulse.composite.state}
            </div>
            <div className="mono pulse-composite-score">
              {pulse.composite.value} / 100
            </div>
          </div>
          <div className="pulse-gauges">
            <Gauge label="GLOBAL RISK" metric={pulse.risk} />
            <Gauge label="MOMENTUM" metric={pulse.momentum} />
            <Gauge label="BREADTH" metric={pulse.breadth} />
            <Gauge label="VOLATILITY (CALMNESS)" metric={pulse.volatility} />
          </div>
        </div>
      )}
    </TerminalPanel>
  );
}
