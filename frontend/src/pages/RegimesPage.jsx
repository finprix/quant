import { useState } from "react";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import { RegimeBadge, StatusBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  NoDatasetState,
} from "../components/states/States.jsx";
import { PriceTimeline } from "../components/charts/primitives.jsx";
import { buildDerivedFrame } from "../lib/marketMath.js";
import {
  formatPercent,
  formatSignedPercent,
  formatConfidence,
  formatNumber,
} from "../lib/format.js";

const REGIME_COLORS = ["#8b1e2d", "#c8ae8d", "#5a4a3a", "#701626", "#30231d", "#a62b3d"];

function regimeColor(id) {
  return REGIME_COLORS[(id ?? 0) % REGIME_COLORS.length];
}

function TransitionCell({ p }) {
  const alpha = Math.min(0.92, Math.max(0.04, p * 1.1));
  return (
    <td
      className="mono"
      style={{
        textAlign: "center",
        background: `rgba(166, 43, 61, ${alpha})`,
        color: alpha > 0.5 ? "#f2ece6" : "#e7e1dc",
      }}
    >
      {p.toFixed(2)}
    </td>
  );
}

export default function RegimesPage() {
  const { activeId, activeDataset } = useDatasets();
  const [windowSize, setWindowSize] = useState(60);

  const query = useApiData(
    activeId ? `/datasets/${activeId}/regimes?window_size=${windowSize}` : null,
  );
  const pricesQuery = useApiData(
    activeId ? `/datasets/${activeId}/prices` : null,
  );

  if (!activeId) {
    return (
      <div className="page">
        <SectionHeader title="Regime Discovery" />
        <NoDatasetState />
      </div>
    );
  }

  if (query.loading && !query.data) {
    return (
      <div className="page">
        <SectionHeader title="Regime Discovery" />
        <LoadingState label="RUNNING PCA · KMEANS DISCOVERY" />
      </div>
    );
  }

  if (query.error && !query.data) {
    return (
      <div className="page">
        <SectionHeader title="Regime Discovery" />
        <ErrorState
          message={query.error.message}
          status={query.error.status}
          onRetry={query.refetch}
        />
      </div>
    );
  }

  const payload = query.data;
  if (!payload.available) {
    return (
      <div className="page">
        <SectionHeader
          title="Regime Discovery"
          desc="PCA compression and KMeans clustering over sliding market windows."
          right={
            <div className="chip-row">
              {[40, 60].map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`chip-btn${w === windowSize ? " active" : ""}`}
                  onClick={() => setWindowSize(w)}
                >
                  WINDOW {w}
                </button>
              ))}
            </div>
          }
        />
        <EmptyState
          title="INSUFFICIENT DATA"
          hint={payload.message || "Regime discovery requires more overlapping windows than this history provides."}
        />
      </div>
    );
  }

  const regimes = payload.regimes ?? [];
  const timeline = payload.timeline ?? [];
  const current = payload.current_regime?.current_regime ?? payload.current_regime;
  const transitions = payload.transitions;
  const model = payload.model ?? {};

  // Price series for the timeline chart (genuine closes)
  const priceRows = pricesQuery.data?.prices ?? [];
  const frame = priceRows.length > 1 ? buildDerivedFrame(priceRows) : null;
  const timelineData = frame
    ? frame.dates.map((date, i) => ({ date, close: frame.closes[i] }))
    : [];

  // Regime occupancy strip: proportional segments by window count
  const totalWindows = regimes.reduce((acc, r) => acc + (r.window_count ?? 0), 0) || 1;

  return (
    <div className="page">
      <SectionHeader
        title="Regime Analysis"
        desc={`Unsupervised market-state discovery for ${activeDataset?.filename ?? "dataset"} · window ${windowSize}D`}
        right={
          <>
            <div className="chip-row">
              {[40, 60].map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`chip-btn${w === windowSize ? " active" : ""}`}
                  onClick={() => setWindowSize(w)}
                >
                  WINDOW {w}
                </button>
              ))}
            </div>
            <StatusBadge tone="neutral">
              K = {model.selected_k ?? "?"}{model.requested_k == null ? " (AUTO)" : ""}
            </StatusBadge>
            {payload.meta?.cached ? <StatusBadge tone="neutral">CACHED</StatusBadge> : null}
          </>
        }
      />

      {/* Current regime hero */}
      <TerminalPanel title="Current Regime">
        {current && current.regime_id != null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 42, fontWeight: 700, color: regimeColor(current.regime_id), letterSpacing: "0.08em" }}>
              R{String(current.regime_id + 1).padStart(2, "0")}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 17, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                {current.label ?? "—"}
              </span>
              <span className="ctx-value" style={{ color: "var(--muted)" }}>
                CONFIDENCE {formatConfidence(current.confidence)} · WINDOW{" "}
                {current.window?.start_date} → {current.window?.end_date}
              </span>
            </div>
          </div>
        ) : (
          <EmptyState title="CURRENT PROJECTION UNAVAILABLE" hint={payload.current_regime?.message} />
        )}
      </TerminalPanel>

      {/* Regime timeline strip + price */}
      <TerminalPanel
        title="Regime Timeline"
        subtitle={`${timeline.length} classified windows beneath price history`}
        flush
      >
        <div style={{ padding: "10px 14px 0" }}>
          <div style={{ display: "flex", height: 16, borderRadius: 2, overflow: "hidden", border: "1px solid var(--border)" }}>
            {timeline.map((t, i) => (
              <div
                key={i}
                  title={`R${t.regime_id + 1} · ${t.start_date} → ${t.end_date} · conf ${(t.confidence * 100).toFixed(0)}%`}
                  style={{
                    flexGrow: 1,
                    background: regimeColor(t.regime_id),
                    opacity: 0.55 + 0.45 * (t.confidence ?? 0),
                    borderRight: "1px solid var(--bg-1)",
                  }}
                />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
            <span className="ctx-label">{timeline[0]?.start_date}</span>
            <span className="ctx-label">{timeline[timeline.length - 1]?.end_date}</span>
          </div>
        </div>
        {timelineData.length > 1 ? (
          <PriceTimeline data={timelineData} height={260} />
        ) : (
          <LoadingState label="LOADING PRICES" />
        )}
      </TerminalPanel>

      {/* Occupancy */}
      <MetricStrip
        items={regimes.map((r) => ({
          label: `R${String(r.regime_id + 1).padStart(2, "0")} OCCUPANCY`,
          value: formatPercent((r.window_count ?? 0) / totalWindows),
          delta: `${r.window_count ?? 0} windows`,
          tone: undefined,
        }))}
      />

      {/* Characteristics */}
      <TerminalPanel title="Regime Characteristics & Forward Outcomes" flush subtitle="Historical behaviour of windows grouped in each regime">
        <div style={{ overflowX: "auto" }}>
          <table className="dna-table">
            <thead>
              <tr>
                <th>Regime</th>
                <th style={{ textAlign: "right" }}>Occ</th>
                <th style={{ textAlign: "right" }}>Vol (ann.)</th>
                <th style={{ textAlign: "right" }}>Max DD</th>
                <th style={{ textAlign: "right" }}>Mom 20D</th>
                <th style={{ textAlign: "right" }}>Fwd 5D Avg</th>
                <th style={{ textAlign: "right" }}>Fwd 10D Avg</th>
                <th style={{ textAlign: "right" }}>Fwd 20D Med</th>
                <th style={{ textAlign: "right" }}>P(Fwd20 &gt; 0)</th>
              </tr>
            </thead>
            <tbody>
              {regimes.map((r) => {
                const fwd = r.forward_outcomes ?? {};
                return (
                  <tr key={r.regime_id}>
                    <td className="text-cell">
                      <span style={{ display: "inline-block", width: 9, height: 9, marginRight: 7, background: regimeColor(r.regime_id) }} />
                      R{String(r.regime_id + 1).padStart(2, "0")} · {(r.label ?? "").toUpperCase()}
                    </td>
                    <td style={{ textAlign: "right" }}>{r.window_count ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{formatPercent(r.volatility)}</td>
                    <td style={{ textAlign: "right" }} className="num-neg">{formatSignedPercent(r.max_drawdown)}</td>
                    <td style={{ textAlign: "right" }}>{formatSignedPercent(r.avg_momentum_20)}</td>
                    <td style={{ textAlign: "right" }} className={fwd.avg_return_after_5_days >= 0 ? "num-pos" : "num-neg"}>
                      {fwd.available ? formatSignedPercent(fwd.avg_return_after_5_days) : "N/A"}
                    </td>
                    <td style={{ textAlign: "right" }} className={fwd.avg_return_after_10_days >= 0 ? "num-pos" : "num-neg"}>
                      {fwd.available ? formatSignedPercent(fwd.avg_return_after_10_days) : "N/A"}
                    </td>
                    <td style={{ textAlign: "right" }} className={fwd.median_return_after_20_days >= 0 ? "num-pos" : "num-neg"}>
                      {fwd.available ? formatSignedPercent(fwd.median_return_after_20_days) : "N/A"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {fwd.available ? formatPercent(fwd.probability_positive_after_20_days) : "N/A"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </TerminalPanel>

      <div className="grid-2">
        {/* Transition matrix */}
        <TerminalPanel title="Transition Matrix" subtitle="P(next regime | current regime), row-normalized historical frequencies">
          {transitions?.probabilities ? (
            <div style={{ overflowX: "auto" }}>
              <table className="dna-table">
                <thead>
                  <tr>
                    <th>FROM ↓ / TO →</th>
                    {transitions.labels.map((label, i) => (
                      <th key={i} style={{ textAlign: "center" }}>
                        R{String(transitions.regime_ids[i] + 1).padStart(2, "0")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {transitions.probabilities.map((row, i) => (
                    <tr key={i}>
                      <td className="text-cell" style={{ color: "var(--muted)" }}>
                        R{String(transitions.regime_ids[i] + 1).padStart(2, "0")} ·{" "}
                        {transitions.labels[i].split("/")[0].trim().toUpperCase()}
                      </td>
                      {row.map((p, j) => (
                        <TransitionCell key={j} p={p} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="TRANSITIONS UNAVAILABLE" />
          )}
        </TerminalPanel>

        {/* Model quality */}
        <TerminalPanel title="Cluster Model Quality" subtitle="KMeans selection across candidate k values">
          <MetricStrip
            items={[
              { label: "Selected k", value: String(model.selected_k ?? "—"), tone: "biscuit" },
              { label: "Silhouette", value: formatNumber(model.silhouette, 3) },
              { label: "Windows", value: String(payload.n_windows ?? "—") },
              { label: "PCA Components", value: String(payload.pca?.n_components ?? "—") },
            ]}
          />
          <table className="dna-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>k</th>
                <th style={{ textAlign: "right" }}>Silhouette ↑</th>
                <th style={{ textAlign: "right" }}>Inertia</th>
              </tr>
            </thead>
            <tbody>
              {(model.quality_by_k ?? []).map((q) => (
                <tr key={q.k} className={q.k === model.selected_k ? "selected" : ""}>
                  <td>{q.k}</td>
                  <td style={{ textAlign: "right" }}>{formatNumber(q.silhouette, 3)}</td>
                  <td style={{ textAlign: "right" }}>{formatNumber(q.inertia, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="disclaimer-text" style={{ marginTop: 8 }}>
            {payload.disclaimer}
          </p>
        </TerminalPanel>
      </div>

      <p className="disclaimer-text">
        Regimes are clusters of statistical window profiles — descriptive groupings of past
        behaviour, not ground truth or predictions. Transition probabilities are historical
        frequencies.
      </p>
    </div>
  );
}
