import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { TerminalPanel } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import { StatusBadge, RegimeBadge } from "../components/common/StatusBadge.jsx";
import { PercentileBar } from "../components/common/PercentileBar.jsx";
import {
  LoadingState,
  ErrorState,
  NoDatasetState,
} from "../components/states/States.jsx";
import {
  formatSignedPercent,
  formatPercent,
  formatConfidence,
  formatPrice,
} from "../lib/format.js";

function EvidenceContribution({ label, score, weight }) {
  const magnitude = Math.min(1, Math.abs(score ?? 0));
  const positive = (score ?? 0) >= 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 130px", gap: 10, alignItems: "center", padding: "5px 0" }}>
      <span className="metric-label">{label}</span>
      <div className="pct-bar-track">
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: 1,
            background: "var(--border-strong)",
          }}
        />
        <div
          style={{
            position: "relative",
            height: "100%",
            width: `${magnitude * 48}%`,
            marginLeft: positive ? "50%" : `${50 - magnitude * 48}%`,
            background: positive
              ? "linear-gradient(90deg, var(--burgundy-700), var(--burgundy-accent))"
              : "#6b382f",
            transition: "width 300ms ease",
          }}
        />
      </div>
      <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>
        {score >= 0 ? "+" : ""}
        {(score ?? 0).toFixed(3)}{" "}
        <span style={{ color: "var(--muted-2)" }}>· w={weight?.toFixed(2) ?? "—"}</span>
      </span>
    </div>
  );
}

export default function IntelligencePage() {
  const { activeId } = useDatasets();
  const query = useApiData(activeId ? `/datasets/${activeId}/intelligence` : null);

  if (!activeId) {
    return (
      <div className="analysis-view">
        <div className="view-head">
          <span className="view-title mono">MARKET INTELLIGENCE</span>
        </div>
        <NoDatasetState />
      </div>
    );
  }

  if (query.loading && !query.data) {
    return (
      <div className="analysis-view">
        <div className="view-head">
          <span className="view-title mono">MARKET INTELLIGENCE</span>
        </div>
        <LoadingState label="FUSING EVIDENCE STREAMS" />
      </div>
    );
  }

  if (query.error && !query.data) {
    return (
      <div className="analysis-view">
        <div className="view-head">
          <span className="view-title mono">MARKET INTELLIGENCE</span>
        </div>
        <ErrorState
          title="INTELLIGENCE UNAVAILABLE"
          message={query.error.message}
          status={query.error.status}
          onRetry={query.refetch}
        />
      </div>
    );
  }

  const payload = query.data;
  const sc = payload.scorecard ?? {};
  const ev = payload.evidence ?? {};
  const cs = payload.current_state ?? {};
  const consensus = payload.analogue_consensus ?? {};
  const regimeCtx = payload.current_regime_context ?? {};
  const weights = ev.weights_used ?? {};
  const quality = ev.quality_factors ?? {};

  const biasTone =
    ev.bias_score > 0.15 ? "up" : ev.bias_score < -0.15 ? "down" : "warn";
  const riskTone =
    sc.risk_level === "high" ? "down" : sc.risk_level === "low" ? "up" : "warn";

  return (
    <div className="analysis-view">
      <div className="view-head">
        <span className="view-title mono">MARKET INTELLIGENCE</span>
        <span className="view-desc fineprint">
          Evidence fusion across trend, analogue, regime and risk streams.
        </span>
        <span className="view-badges">
          <StatusBadge tone={biasTone}>
            BIAS {ev.bias_score >= 0 ? "+" : ""}
            {(ev.bias_score ?? 0).toFixed(2)}
          </StatusBadge>
          <StatusBadge tone={riskTone}>RISK {(sc.risk_level ?? "?").toUpperCase()}</StatusBadge>
          <StatusBadge tone="neutral">CONF {formatConfidence(sc.confidence)}</StatusBadge>
        </span>
      </div>

      {/* CURRENT STATE */}
      <TerminalPanel title="Current State" subtitle={`As of ${cs.latest_date ?? "—"} · close ${formatPrice(cs.latest_close)}`}>
        <MetricStrip
          items={[
            { label: "Directional Bias", value: (sc.directional_bias ?? "—").toUpperCase(), tone: biasTone === "up" ? "" : biasTone },
            { label: "Trend", value: (sc.trend_state ?? "—").toUpperCase() },
            { label: "Momentum", value: (sc.momentum_state ?? "—").toUpperCase() },
            { label: "Volatility", value: (sc.volatility_state ?? "—").toUpperCase() },
            { label: "Drawdown State", value: (sc.drawdown_state ?? "—").toUpperCase() },
            { label: "Current DD", value: formatSignedPercent(cs.current_drawdown) },
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <PercentileBar label="VOLATILITY PERCENTILE" value={(cs.volatility_percentile ?? 0) * 100} format={() => formatPercent(cs.volatility_percentile)} />
          <PercentileBar label="ANALOGUE AGREEMENT" value={(sc.analogue_agreement ?? 0) * 100} variant="biscuit" />
          <PercentileBar label="POSITIVE 20D ANALOGUE FREQ." value={(sc.positive_20d_analogue_frequency ?? 0) * 100} />
        </div>
      </TerminalPanel>

      <div className="grid-2">
        {/* COMPOSITE EVIDENCE */}
        <TerminalPanel title="Composite Evidence" subtitle="Bounded component scores and the weights used to fuse them">
          <EvidenceContribution label="TREND" score={ev.trend_score} weight={weights.trend} />
          <EvidenceContribution label="ANALOGUES" score={ev.analogue_score} weight={weights.analogues} />
          <EvidenceContribution label="REGIME" score={ev.regime_score} weight={weights.regime} />
          <EvidenceContribution label="RISK" score={ev.risk_score} weight={weights.risk} />
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 8 }}>
            <EvidenceContribution label="BIAS SCORE" score={ev.bias_score} weight={1} />
          </div>
          <p className="disclaimer-text" style={{ marginTop: 8 }}>
            Weights adapt: regime weight scales with regime-assignment confidence; analogue
            weight decreases when forward-outcome dispersion is high.
          </p>
          <div style={{ overflowX: "auto", borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 8 }}>
            <table className="dna-table compact">
              <thead>
                <tr>
                  <th>Component</th>
                  <th style={{ textAlign: "right" }}>Score</th>
                  <th style={{ textAlign: "right" }}>Weight</th>
                  <th style={{ textAlign: "right" }}>Contribution</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["TREND", ev.trend_score, weights.trend],
                  ["ANALOGUES", ev.analogue_score, weights.analogues],
                  ["REGIME", ev.regime_score, weights.regime],
                  ["RISK", ev.risk_score, weights.risk],
                ].map(([label, score, weight]) => {
                  const has = typeof score === "number" && typeof weight === "number";
                  return (
                    <tr key={label}>
                      <td className="text-cell">{label}</td>
                      <td style={{ textAlign: "right" }} className="mono">
                        {has ? score.toFixed(3) : "N/A"}
                      </td>
                      <td style={{ textAlign: "right" }} className="mono">
                        {typeof weight === "number" ? weight.toFixed(2) : "N/A"}
                      </td>
                      <td
                        style={{ textAlign: "right" }}
                        className={`mono ${has && score * weight >= 0 ? "num-pos" : "num-neg"}`}
                      >
                        {has ? formatSignedPercent(score * weight, 1) : "N/A"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TerminalPanel>

        {/* ANALOGUE EVIDENCE */}
        <TerminalPanel title="Analogue Evidence" subtitle={`${consensus.valid_analogues ?? "?"} valid historical analogues of the current window`}>
          <table className="dna-table">
            <tbody>
              {[
                ["Median 5D forward return", formatSignedPercent(consensus.median_5d_forward_return)],
                ["Median 10D forward return", formatSignedPercent(consensus.median_10d_forward_return)],
                ["Median 20D forward return", formatSignedPercent(consensus.median_20d_forward_return)],
                ["Positive 5D frequency", formatPercent(consensus.positive_5d_frequency)],
                ["Positive 20D frequency", formatPercent(consensus.positive_20d_frequency)],
                ["20D outcome dispersion (σ)", formatPercent(consensus.std_dev_20d_forward_return)],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td className="text-cell" style={{ color: "var(--muted)", border: "none", padding: "5px 8px 5px 0" }}>{label}</td>
                  <td style={{ border: "none", textAlign: "right" }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="disclaimer-text" style={{ marginTop: 8 }}>
            Observed analogue outcomes describe what historically followed statistically similar
            windows. They are statistical tendencies, not predictions.
          </p>
        </TerminalPanel>

        {/* REGIME CONTEXT */}
        <TerminalPanel title="Regime Context" subtitle="Regime-conditioned historical behaviour">
          {regimeCtx.regime_id != null ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <RegimeBadge
                  regimeId={regimeCtx.regime_id}
                  confidence={regimeCtx.regime_confidence}
                  label={regimeCtx.regime_label?.split("/")[0]?.trim()}
                />
              </div>
              <table className="dna-table">
                <tbody>
                  {[
                    ["Full regime label", (regimeCtx.regime_label ?? "—").toUpperCase()],
                    ["Historical frequency", formatPercent(regimeCtx.historical_frequency)],
                    ["Average duration (days)", regimeCtx.average_duration_days != null ? String(Math.round(regimeCtx.average_duration_days)) : "N/A"],
                    ["Avg window return", formatSignedPercent(regimeCtx.profile?.avg_window_return)],
                    ["Regime volatility", formatPercent(regimeCtx.profile?.volatility)],
                  ].map(([label, value]) => (
                    <tr key={label}>
                      <td className="text-cell" style={{ color: "var(--muted)", border: "none", padding: "5px 8px 5px 0" }}>{label}</td>
                      <td style={{ border: "none", textAlign: "right" }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="state-hint">Regime context unavailable for this dataset.</p>
          )}
        </TerminalPanel>

        {/* RISK & QUALITY */}
        <TerminalPanel title="Risk & Evidence Quality">
          <MetricStrip
            items={[
              { label: "Risk Index", value: (ev.risk_index ?? 0).toFixed(3), tone: (ev.risk_index ?? 0) > 0.6 ? "down" : undefined },
              { label: "Risk Level", value: (sc.risk_level ?? "—").toUpperCase() },
              { label: "Agreement Score", value: (ev.agreement_score ?? 0).toFixed(3) },
              { label: "Coverage", value: formatPercent(quality.evidence_coverage) },
            ]}
          />
          <div style={{ marginTop: 12 }}>
            <PercentileBar label="REGIME CONFIDENCE" value={(quality.regime_confidence ?? 0) * 100} variant="biscuit" />
            <PercentileBar label="ANALOGUE SAMPLE QUALITY" value={(quality.analogue_sample_quality ?? 0) * 100} />
            <PercentileBar label="DISPERSION INDEX (lower = tighter)" value={(quality.analogue_dispersion_index ?? 0) * 100} />
          </div>
        </TerminalPanel>
      </div>

      {/* CONTRADICTIONS + NARRATIVE */}
      <div className="grid-side">
        <TerminalPanel title="Narrative Summary">
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>{payload.summary?.summary ?? payload.summary ?? "—"}</p>
        </TerminalPanel>
        <TerminalPanel title={`Contradictions${payload.contradictions?.length ? ` · ${payload.contradictions.length}` : ""}`}>
          {payload.contradictions?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {payload.contradictions.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <StatusBadge tone={c.severity === "high" ? "down" : c.severity === "medium" ? "warn" : undefined}>
                    {(c.severity ?? "info").toUpperCase()}
                  </StatusBadge>
                  <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>{c.description}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="state-hint">No material contradictions between evidence streams.</p>
          )}
        </TerminalPanel>
      </div>

      <p className="disclaimer-text">
        {Array.isArray(payload.disclaimers) ? payload.disclaimers.join(" ") : ""}
      </p>
    </div>
  );
}
