import { useEffect, useMemo, useState } from "react";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import { PercentileBar } from "../components/common/PercentileBar.jsx";
import { RegimeBadge, StatusBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  NoDatasetState,
} from "../components/states/States.jsx";
import { PriceTimeline } from "../components/charts/primitives.jsx";
import MarketOverviewPanel from "../components/market/MarketOverviewPanel.jsx";
import OverviewMovers from "../components/market/OverviewMovers.jsx";
import {
  buildDerivedFrame,
  percentileRank,
} from "../lib/marketMath.js";
import {
  formatPrice,
  formatSignedPercent,
  formatPercent,
  formatConfidence,
} from "../lib/format.js";

const OVERLAY_OPTIONS = [
  { key: "drawdown", label: "DRAWDOWN" },
];

function toneFromSigned(value) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

export default function Overview() {
  const { activeId, activeDataset } = useDatasets();
  const [overlays, setOverlays] = useState({ drawdown: true });

  const detailPath = activeId ? `/datasets/${activeId}` : null;
  const summaryPath = activeId
    ? `/datasets/${activeId}/intelligence/summary`
    : null;
  const regimePath = activeId
    ? `/datasets/${activeId}/regimes/current?window_size=60`
    : null;
  const pricesPath = activeId ? `/datasets/${activeId}/prices` : null;

  const detailQuery = useApiData(detailPath);
  const summaryQuery = useApiData(summaryPath);
  const regimeQuery = useApiData(regimePath);
  const pricesQuery = useApiData(pricesPath);

  // Centralized auto-refresh: stored-universe metrics stay current without
  // any component hitting external providers directly.
  useEffect(() => {
    if (!activeId) return undefined;
    const timer = setInterval(() => {
      detailQuery.refetch();
      summaryQuery.refetch();
      regimeQuery.refetch();
    }, 60_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const frame = useMemo(() => {
    const rows = pricesQuery.data?.prices;
    if (!rows || rows.length === 0) return null;
    return buildDerivedFrame(rows);
  }, [pricesQuery.data]);

  if (!activeId) {
    return (
      <div className="page">
        <SectionHeader title="Market Overview" desc="Current statistical state of the selected market." />
        <NoDatasetState />
        <OverviewMovers />
      </div>
    );
  }

  const anyLoading =
    detailQuery.loading ||
    pricesQuery.loading ||
    summaryQuery.loading ||
    regimeQuery.loading;

  if (anyLoading && !detailQuery.data) {
    return (
      <div className="page">
        <SectionHeader title="Market Overview" />
        <LoadingState label="LOADING MARKET STATE" />
      </div>
    );
  }

  const hardError = detailQuery.error && !detailQuery.data;
  if (hardError) {
    return (
      <div className="page">
        <SectionHeader title="Market Overview" />
        <ErrorState
          message={detailQuery.error.message}
          status={detailQuery.error.status}
          onRetry={detailQuery.refetch}
        />
      </div>
    );
  }

  const metrics = detailQuery.data?.metrics ?? {};
  const summary = summaryQuery.data;
  const scorecard = summary?.scorecard ?? null;
  const regime = regimeQuery.data?.available
    ? regimeQuery.data.current_regime
    : null;

  // Derived from genuine price series
  const lastIdx = frame ? frame.dates.length - 1 : -1;
  const ret1d = lastIdx >= 0 ? frame.returns[lastIdx] : null;
  const ret20d = lastIdx >= 0 ? frame.mom20[lastIdx] : null;
  const vol20Ann =
    lastIdx >= 0 && frame.vol20[lastIdx] != null
      ? frame.vol20[lastIdx]
      : metrics.annualized_volatility ?? null;
  const maxDD = metrics.max_drawdown ?? null;
  const currentDD = lastIdx >= 0 ? frame.drawdown[lastIdx] : null;
  const maGap = lastIdx >= 0 && frame.ma20[lastIdx]
    ? frame.closes[lastIdx] / frame.ma20[lastIdx] - 1
    : null;

  const pctTrend = percentileRank(frame ? frame.ma20.map((m, i) =>
    m ? frame.closes[i] / m - 1 : null) : [], maGap);
  const pctMomentum = percentileRank(frame ? frame.mom20 : [], ret20d);
  const pctVol = percentileRank(frame ? frame.vol20 : [], vol20Ann);
  const pctDD = percentileRank(frame ? frame.drawdown : [], currentDD);

  const timelineData = (() => {
    if (!frame) return [];
    return frame.dates.map((date, i) => ({
      date,
      close: frame.closes[i],
      ...(overlays.drawdown ? { drawdown: Math.round((frame.drawdown[i] ?? 0) * 10000) / 100 } : {}),
    }));
  })();

  const stripItems = [
    { label: "Last Close", value: formatPrice(metrics.latest_close) },
    {
      label: "1D Return",
      value: formatSignedPercent(ret1d),
      tone: toneFromSigned(ret1d),
    },
    {
      label: "20D Return",
      value: formatSignedPercent(ret20d),
      tone: toneFromSigned(ret20d),
    },
    {
      label: "Volatility (ann.)",
      value: vol20Ann != null ? formatPercent(vol20Ann) : "N/A",
    },
    {
      label: "Max Drawdown",
      value: formatSignedPercent(maxDD),
      tone: maxDD != null && maxDD < 0 ? "down" : "",
    },
    {
      label: "Trend State",
      value: (scorecard?.trend_state ?? "N/A").toUpperCase(),
      tone: scorecard ? undefined : undefined,
    },
    {
      label: "Momentum State",
      value: (scorecard?.momentum_state ?? "N/A").toUpperCase(),
    },
    {
      label: "Current Regime",
      value: regime ? `R${String(regime.regime_id + 1).padStart(2, "0")}` : "UNAVAILABLE",
      tone: "biscuit",
    },
    {
      label: "Intelligence Score",
      value:
        summary?.evidence?.bias_score != null
          ? `${summary.evidence.bias_score >= 0 ? "+" : ""}${summary.evidence.bias_score.toFixed(2)}`
          : "N/A",
      tone: toneFromSigned(summary?.evidence?.bias_score ?? 0),
    },
  ];

  return (
    <div className="page">
      <SectionHeader
        title="Market Overview"
        desc={`Current statistical state of ${activeDataset?.filename ?? "the selected market"}.`}
        right={<StatusBadge tone="neutral">{`#${activeId} · ${activeDataset?.row_count ?? "?"} ROWS`}</StatusBadge>}
      />

      <MarketOverviewPanel />

      <OverviewMovers />

      <MetricStrip items={stripItems} />

      <div className="grid-side">
        <TerminalPanel
          title="Market State"
          subtitle="Percentile of latest value vs this dataset's own history"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <PercentileBar label="TREND" value={pctTrend ?? 0} format={() => (pctTrend == null ? "N/A" : `${Math.round(pctTrend)}%`)} />
            <PercentileBar label="MOMENTUM 20D" value={pctMomentum ?? 0} format={() => (pctMomentum == null ? "N/A" : `${Math.round(pctMomentum)}%`)} variant="biscuit" />
            <PercentileBar label="VOLATILITY" value={pctVol ?? 0} format={() => (pctVol == null ? "N/A" : `${Math.round(pctVol)}%`)} />
            <PercentileBar label="DRAWDOWN DEPTH" value={100 - (pctDD ?? 0)} format={() => (pctDD == null ? "N/A" : `${Math.round(pctDD)}%`)} variant="biscuit" />
          </div>

          <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="ctx-item" style={{ border: "none", padding: 0 }}>
              <span className="ctx-label">Current Regime</span>
              {regime ? (
                <RegimeBadge regimeId={regime.regime_id} confidence={regime.confidence} />
              ) : (
                <span className="metric-value">UNAVAILABLE</span>
              )}
            </div>
            {regime?.label ? (
              <div className="disclaimer-text">{regime.label}</div>
            ) : null}
            <div className="ctx-item" style={{ border: "none", padding: 0 }}>
              <span className="ctx-label">Evidence Score</span>
              <span className="metric-value">
                {summary?.evidence?.bias_score != null
                  ? `${summary.evidence.bias_score >= 0 ? "+" : ""}${summary.evidence.bias_score.toFixed(3)}`
                  : "N/A"}
              </span>
            </div>
            <div className="ctx-item" style={{ border: "none", padding: 0 }}>
              <span className="ctx-label">Confidence</span>
              <span className="metric-value biscuit">
                {formatConfidence(summary?.confidence)}
              </span>
            </div>
          </div>
        </TerminalPanel>

        <TerminalPanel
          title="Price & State Timeline"
          subtitle={`${activeDataset?.start_date} → ${activeDataset?.end_date}`}
          actions={
            <>
              {OVERLAY_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={`chip-btn${overlays[opt.key] ? " active" : ""}`}
                  onClick={() =>
                    setOverlays((prev) => ({ ...prev, [opt.key]: !prev[opt.key] }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </>
          }
        >
          {timelineData.length > 1 ? (
            <PriceTimeline data={timelineData} height={320} showDrawdown={overlays.drawdown} />
          ) : (
            <EmptyState
              title="INSUFFICIENT DATA"
              hint="This analysis requires at least a few observations."
            />
          )}
        </TerminalPanel>
      </div>

      <TerminalPanel title="Intelligence Summary" subtitle="Generated by the Quant Vector evidence engine">
        {summaryQuery.error && !summaryQuery.data ? (
          <ErrorState
            title="INTELLIGENCE UNAVAILABLE"
            message={summaryQuery.error.message}
            status={summaryQuery.error.status}
            onRetry={summaryQuery.refetch}
          />
        ) : !summary ? (
          <LoadingState label="LOADING INTELLIGENCE" />
        ) : (
          <>
            <div className="metric-strip" style={{ gridAutoColumns: "minmax(140px, 1fr)", marginBottom: 12 }}>
              {[
                ["TREND", (summary.trend_state ?? "—").toUpperCase()],
                ["MOMENTUM", (scorecard?.momentum_state ?? "—").toUpperCase()],
                ["VOLATILITY", (summary.volatility_state ?? "—").toUpperCase()],
                ["REGIME", (summary.current_regime?.label ?? "unavailable").toUpperCase()],
                ["EVIDENCE", `${summary.evidence?.bias_score >= 0 ? "+" : ""}${summary.evidence?.bias_score?.toFixed(2) ?? "—"}`],
                ["CONFIDENCE", formatConfidence(summary.confidence)],
              ].map(([label, value]) => (
                <div className="metric-tile" key={label}>
                  <span className="metric-label">{label}</span>
                  <span className="metric-value" style={{ fontSize: 13 }}>{value}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--text)" }}>
              {summary.summary ?? "No narrative available."}
            </p>
            {Array.isArray(summary.disclaimers) && summary.disclaimers.length > 0 ? (
              <div style={{ marginTop: 10 }} className="disclaimer-text">
                {summary.disclaimers[0]}
              </div>
            ) : null}
          </>
        )}
      </TerminalPanel>
    </div>
  );
}
