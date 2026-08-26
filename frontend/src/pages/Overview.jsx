import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
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
import MoversCard from "../components/common/MoversCard.jsx";
import NewsPanel from "../components/market/NewsPanel.jsx";
import GlobalSearch from "../components/layout/GlobalSearch.jsx";
import useWatchlistData from "../hooks/useWatchlistData.js";
import useSymbolImport from "../hooks/useSymbolImport.js";
import { buildDerivedFrame } from "../lib/marketMath.js";
import {
  formatPrice,
  formatSignedPercent,
  formatPercent,
  formatRelativeTime,
} from "../lib/format.js";
import {
  ANALYSIS_VIEWS,
  analysisPath,
  fingerprintPath,
  symbolFromFilename,
} from "../lib/navigation.js";

const REFRESH_MS = 60_000;

function toneFromSigned(value) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

/**
 * OVERVIEW — command center (v0.19.0 ownership model).
 * Answers: what am I tracking, what is happening now, what am I analyzing,
 * what should I look at next. Summaries only — every block links deeper.
 */
export default function Overview() {
  const { activeId, activeDataset, recentAnalyses } = useDatasets();
  const { isDeveloper } = useAuth();
  const [showDrawdown, setShowDrawdown] = useState(true);
  const [launchingSym, setLaunchingSym] = useState(null);

  const { rows: watchRows, gainers, losers, error: watchError } =
    useWatchlistData({ withUniverse: true, pollMs: REFRESH_MS });
  const { launch, phase: importPhase, stage: importStage } = useSymbolImport({
    onComplete: (datasetId) => window.location.assign(fingerprintPath(datasetId)),
  });
  const importing = importPhase === "importing";

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

  useEffect(() => {
    if (!activeId) return undefined;
    const timer = setInterval(() => {
      detailQuery.refetch();
      summaryQuery.refetch();
      regimeQuery.refetch();
    }, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const frame = useMemo(() => {
    const rows = pricesQuery.data?.prices;
    if (!rows || rows.length === 0) return null;
    return buildDerivedFrame(rows);
  }, [pricesQuery.data]);

  const metrics = detailQuery.data?.metrics ?? {};
  const summary = summaryQuery.data;
  const regime = regimeQuery.data?.available
    ? regimeQuery.data.current_regime
    : null;
  const symbol = symbolFromFilename(activeDataset?.filename);
  const evidenceBias = summary?.evidence?.bias_score ?? null;

  const lastIdx = frame ? frame.dates.length - 1 : -1;
  const ret1d = lastIdx >= 0 ? frame.returns[lastIdx] : null;
  const ret20d = lastIdx >= 0 ? frame.mom20[lastIdx] : null;
  const vol20Ann =
    lastIdx >= 0 && frame.vol20[lastIdx] != null
      ? frame.vol20[lastIdx]
      : metrics.annualized_volatility ?? null;
  const maxDD = metrics.max_drawdown ?? null;
  const currentDD = lastIdx >= 0 ? frame.drawdown[lastIdx] : null;

  const timelineData = (() => {
    if (!frame) return [];
    return frame.dates.map((date, i) => ({
      date,
      close: frame.closes[i],
      ...(showDrawdown
        ? { drawdown: Math.round((frame.drawdown[i] ?? 0) * 10000) / 100 }
        : {}),
    }));
  })();

  const watchSymbols = (watchRows || []).map((r) => r.symbol);

  return (
    <div className="page command-center">
      <SectionHeader
        title="Command Center"
        desc="What you are tracking, what is happening now, and where to look next."
        right={
          <StatusBadge tone="neutral">{`${
            activeDataset ? `#${activeId} ACTIVE` : "NO ACTIVE DATASET"
          }`}</StatusBadge>
        }
      />

      {/* DISCOVER */}
      <div className="grid-side cc-discover">
        <TerminalPanel
          title="FIND AN INSTRUMENT"
          subtitle="Provider search — track it or jump straight into live analysis"
        >
          <div className="cc-search">
            <GlobalSearch />
          </div>
        </TerminalPanel>
        <div style={{ display: "flex", gap: 12 }}>
          <MoversCard title="TOP GAINERS" rows={gainers} />
          <MoversCard title="TOP LOSERS" rows={losers} />
        </div>
      </div>

      {/* WATCHLIST */}
      <TerminalPanel
        title="WATCHLIST"
        subtitle={
          watchError
            ? "Live quotes unavailable — showing stored context only"
            : "Regime and evidence come from your stored analyses"
        }
        flush
      >
        {!watchRows && !watchError ? (
          <LoadingState label="LOADING WATCHLIST" />
        ) : !watchRows || watchRows.length === 0 ? (
          <p className="fineprint" style={{ padding: "12px 14px" }}>
            Nothing tracked yet — discover instruments in{" "}
            <Link to="/markets" style={{ color: "var(--accent)" }}>
              Markets
            </Link>{" "}
            or search above.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="dna-table watch-table">
              <thead>
                <tr>
                  <th>SYMBOL</th>
                  <th className="num">PRICE</th>
                  <th className="num">CHANGE %</th>
                  <th>REGIME</th>
                  <th className="num">EVIDENCE</th>
                  <th className="num">STORED</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {watchRows.map((row) => (
                  <tr key={row.symbol}>
                    <td className="mono">{row.symbol}</td>
                    {row.quote_error ? (
                      <>
                        <td colSpan={2}>
                          <span className="error-text">
                            quote unavailable
                          </span>
                        </td>
                        <td>{row.regime_label ?? "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="mono num">{row.quote.price}</td>
                        <td
                          className={`mono num ${
                            row.quote.change_percent >= 0 ? "pos" : "neg"
                          }`}
                        >
                          {row.quote.change_percent != null
                            ? `${row.quote.change_percent > 0 ? "+" : ""}${row.quote.change_percent}%`
                            : "—"}
                        </td>
                        <td>{row.regime_label ?? "—"}</td>
                      </>
                    )}
                    <td
                      className={`mono num ${toneFromSigned(row.evidence_bias)}`}
                    >
                      {row.evidence_bias != null
                        ? `${row.evidence_bias >= 0 ? "+" : ""}${row.evidence_bias.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="mono fineprint">
                      {row.stored ? `#${row.stored.id}` : "—"}
                    </td>
                    <td className="num">
                      {row.stored ? (
                        <Link
                          className="chip-btn"
                          to={fingerprintPath(row.stored.id)}
                        >
                          ANALYZE
                        </Link>
                      ) : isDeveloper ? (
                        <button
                          type="button"
                          className="chip-btn"
                          disabled={importing}
                          onClick={() => {
                            setLaunchingSym(row.symbol);
                            launch(row.symbol);
                          }}
                        >
                          {importing && launchingSym === row.symbol
                            ? importStage || "IMPORTING…"
                            : "IMPORT"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TerminalPanel>

      {/* CURRENT ANALYSIS */}
      {activeId && activeDataset ? (
        <div className="grid-2 cc-current">
          <TerminalPanel
            title={`CURRENT ANALYSIS — ${symbol ?? "#" + activeId}`}
            subtitle={`${activeDataset.filename} · updated ${formatRelativeTime(
              activeDataset.end_date,
            )}`}
          >
            {detailQuery.loading && !detailQuery.data ? (
              <LoadingState label="LOADING MARKET STATE" />
            ) : detailQuery.error && !detailQuery.data ? (
              <ErrorState
                message={detailQuery.error.message}
                status={detailQuery.error.status}
                onRetry={detailQuery.refetch}
              />
            ) : (
              <>
                <MetricStrip
                  items={[
                    { label: "Last Close", value: formatPrice(metrics.latest_close) },
                    { label: "1D Return", value: formatSignedPercent(ret1d), tone: toneFromSigned(ret1d) },
                    { label: "Momentum 20D", value: formatSignedPercent(ret20d), tone: toneFromSigned(ret20d) },
                    { label: "Volatility (ann.)", value: vol20Ann != null ? formatPercent(vol20Ann) : "N/A" },
                    { label: "Max Drawdown", value: formatSignedPercent(maxDD), tone: maxDD != null && maxDD < 0 ? "down" : "" },
                    { label: "Current Drawdown", value: formatSignedPercent(currentDD), tone: currentDD != null && currentDD < 0 ? "down" : "" },
                  ]}
                />
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    marginTop: 10,
                    paddingTop: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div className="ctx-item" style={{ border: "none", padding: 0 }}>
                    <span className="ctx-label">Current Regime</span>
                    {regime ? (
                      <RegimeBadge
                        regimeId={regime.regime_id}
                        confidence={regime.confidence}
                      />
                    ) : (
                      <span className="metric-value">UNAVAILABLE</span>
                    )}
                  </div>
                  <div className="ctx-item" style={{ border: "none", padding: 0 }}>
                    <span className="ctx-label">Evidence Score</span>
                    <span className={`metric-value mono ${toneFromSigned(evidenceBias)}`}>
                      {evidenceBias != null
                        ? `${evidenceBias >= 0 ? "+" : ""}${evidenceBias.toFixed(2)}`
                        : "N/A"}
                    </span>
                  </div>
                </div>
                <div className="cc-open-row">
                  <Link
                    className="btn accent"
                    to={fingerprintPath(activeId)}
                  >
                    OPEN FULL ANALYSIS →
                  </Link>
                  <div className="cc-view-links">
                    {ANALYSIS_VIEWS.slice(1).map((v) => (
                      <Link key={v.key} className="chip-btn" to={analysisPath(v.key, activeId)}>
                        {v.label.toUpperCase()}
                      </Link>
                    ))}
                  </div>
                </div>
              </>
            )}
          </TerminalPanel>

          <TerminalPanel
            title="PRICE & STATE"
            subtitle={`${activeDataset.start_date} → ${activeDataset.end_date}`}
            actions={
              <button
                type="button"
                className={`chip-btn${showDrawdown ? " active" : ""}`}
                onClick={() => setShowDrawdown((v) => !v)}
              >
                DRAWDOWN
              </button>
            }
          >
            {timelineData.length > 1 ? (
              <PriceTimeline
                data={timelineData}
                height={300}
                showDrawdown={showDrawdown}
              />
            ) : pricesQuery.loading ? (
              <LoadingState label="LOADING PRICES" />
            ) : (
              <EmptyState
                title="INSUFFICIENT DATA"
                hint="This dataset has too few observations to chart."
              />
            )}
          </TerminalPanel>
        </div>
      ) : (
        <TerminalPanel title="CURRENT ANALYSIS" subtitle="Pick or import a dataset to begin">
          <NoDatasetState />
        </TerminalPanel>
      )}

      {/* NEXT + NEWS */}
      <div className="grid-side">
        <TerminalPanel
          title="RECENT ANALYSES"
          subtitle="Jump back into something you looked at before"
        >
          {recentAnalyses.length === 0 ? (
            <p className="fineprint">
              Analyses you open will appear here for one-click access.
            </p>
          ) : (
            <div className="recent-list">
              {recentAnalyses.map((r) => (
                <Link
                  key={r.id}
                  className="recent-chip"
                  to={fingerprintPath(r.id)}
                  title={r.dataset.filename}
                >
                  <span className="mono recent-symbol">
                    {symbolFromFilename(r.dataset.filename) ?? `#${r.id}`}
                  </span>
                  <span className="fineprint">{r.dataset.filename}</span>
                  <span className="fineprint mono">{formatRelativeTime(r.ts)}</span>
                </Link>
              ))}
            </div>
          )}
        </TerminalPanel>
        <NewsPanel symbols={watchSymbols} />
      </div>
    </div>
  );
}
