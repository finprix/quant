import { Link } from "react-router-dom";
import { TerminalPanel } from "../common/Panels.jsx";
import { LoadingState } from "../states/States.jsx";

function biasTone(bias) {
  if (!bias) return "";
  const b = String(bias).toLowerCase();
  if (b.includes("bull") || b === "positive" || b === "up") return "pos";
  if (b.includes("bear") || b === "negative" || b === "down") return "neg";
  return "";
}

/**
 * Compact FINPRIX INTELLIGENCE signal for asset pages.
 * Renders only what the engine actually produced — no invented scores.
 * VIEW EVIDENCE links into the Intelligence analysis tab.
 */
export default function FinprixSignal({ datasetId, summary, loading, error }) {
  return (
    <TerminalPanel
      title="FINPRIX INTELLIGENCE"
      subtitle="Evidence-based market state from stored analysis"
    >
      {loading && !summary ? (
        <LoadingState label="READING EVIDENCE" />
      ) : error && !summary ? (
        <p className="fineprint">Intelligence not available yet — run a full analysis.</p>
      ) : !summary ? null : (
        <>
          <div className="signal-hero">
            <span className={`signal-bias mono ${biasTone(summary.directional_bias)}`}>
              {(summary.directional_bias ?? "—").toUpperCase()}
            </span>
            {summary.confidence != null ? (
              <span className="fineprint">
                CONFIDENCE{" "}
                <span className="mono">
                  {Math.round(Number(summary.confidence) * 100)}%
                </span>
              </span>
            ) : null}
          </div>
          <div className="signal-rows">
            <div className="ctx-item">
              <span className="ctx-label">Trend</span>
              <span className="mono">{(summary.trend_state ?? "—").toUpperCase()}</span>
            </div>
            <div className="ctx-item">
              <span className="ctx-label">Volatility</span>
              <span className="mono">{(summary.volatility_state ?? "—").toUpperCase()}</span>
            </div>
            <div className="ctx-item">
              <span className="ctx-label">Regime</span>
              <span className="mono accent">
                {summary.current_regime?.label ?? "—"}
              </span>
            </div>
            <div className="ctx-item">
              <span className="ctx-label">Risk</span>
              <span className="mono">{(summary.risk_level ?? "—").toUpperCase()}</span>
            </div>
          </div>
          {datasetId ? (
            <Link
              className="chip-btn"
              to={`/analysis/intelligence?dataset=${datasetId}`}
            >
              VIEW EVIDENCE →
            </Link>
          ) : null}
        </>
      )}
    </TerminalPanel>
  );
}
