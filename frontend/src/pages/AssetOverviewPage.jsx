import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApiData } from "../hooks/useApiData.js";
import useSymbolBootstrap from "../hooks/useSymbolBootstrap.js";
import FinprixSignal from "../components/market/FinprixSignal.jsx";
import NewsFeed from "../components/market/NewsFeed.jsx";
import { PriceTimeline } from "../components/charts/primitives.jsx";
import { TerminalPanel } from "../components/common/Panels.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
} from "../components/states/States.jsx";
import { buildDerivedFrame } from "../lib/marketMath.js";
import { formatPrice } from "../components/market/MarketCard.jsx";

function fmtSigned(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/**
 * ASSET OVERVIEW — the bridge between discovery and deep quant analysis
 * (v0.20.0). Symbol-first: resolves the instrument, ensures cached
 * history, renders live quote + derived state + Finprix intelligence,
 * and launches the full analysis workspace.
 */
export default function AssetOverviewPage() {
  const { symbol = "" } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [showDrawdown, setShowDrawdown] = useState(false);

  const key = decodeURIComponent(symbol).toUpperCase();
  const { data, error, loading, stage } = useSymbolBootstrap(key, attempt);

  const datasetId = data?.dataset_id ?? null;
  const pricesQuery = useApiData(datasetId ? `/datasets/${datasetId}/prices` : null);
  const summaryQuery = useApiData(
    datasetId ? `/datasets/${datasetId}/intelligence/summary` : null,
  );

  const frame = useMemo(() => {
    const rows = pricesQuery.data?.prices;
    if (!rows || rows.length < 2) return null;
    return buildDerivedFrame(rows);
  }, [pricesQuery.data]);

  const quote = data?.quote;
  const instrument = data?.instrument ?? {};
  const lastIdx = frame ? frame.dates.length - 1 : -1;

  const stats = [
    { label: "1D RETURN", value: fmtSigned(lastIdx >= 0 ? frame?.returns[lastIdx] * 100 : null) },
    { label: "MOMENTUM 20D", value: fmtSigned(lastIdx >= 0 ? frame?.mom20[lastIdx] * 100 : null) },
    {
      label: "VOLATILITY (ANN.)",
      value:
        lastIdx >= 0 && frame?.vol20?.[lastIdx] != null
          ? `${(frame.vol20[lastIdx] * 100).toFixed(1)}%`
          : "—",
    },
    { label: "CURRENT DD", value: fmtSigned(lastIdx >= 0 ? frame?.drawdown[lastIdx] * 100 : null) },
    { label: "PREV CLOSE", value: quote?.previous_close != null ? formatPrice(quote.previous_close) : "—" },
    { label: "VOLUME", value: quote?.volume != null ? quote.volume.toLocaleString() : "—" },
    { label: "HISTORY", value: data?.coverage ? `${data.coverage.row_count?.toLocaleString()} BARS` : "—" },
    { label: "COVERAGE", value: data?.coverage ? `${data.coverage.start_date} → ${data.coverage.end_date}` : "—" },
  ];

  const timelineData = useMemo(() => {
    if (!frame) return [];
    return frame.dates.map((date, i) => ({
      date,
      close: frame.closes[i],
      ...(showDrawdown
        ? { drawdown: Math.round((frame.drawdown[i] ?? 0) * 10000) / 100 }
        : {}),
    }));
  }, [frame, showDrawdown]);

  // ---- loading / failure UX ---------------------------------------------
  if (loading && !data) {
    return (
      <div className="page asset-page">
        <TerminalPanel title={`RESOLVING ${key}`} flush>
          <div className="asset-boot">
            <LoadingState label={stage.toUpperCase()} />
            <p className="fineprint">
              Fetching live market history for {key} — this happens once;
              Finprix caches everything afterwards.
            </p>
          </div>
        </TerminalPanel>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page asset-page">
        <ErrorState
          title={`${key} UNAVAILABLE`}
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      </div>
    );
  }

  const changeTone =
    quote?.change_percent == null ? "" : quote.change_percent >= 0 ? "pos" : "neg";

  return (
    <div className="page asset-page">
      {/* HERO */}
      <section className="asset-hero">
        <div className="asset-hero-ident">
          <h1 className="asset-hero-symbol mono">{instrument.symbol ?? key}</h1>
          <div className="asset-hero-name">{instrument.name ?? "Market instrument"}</div>
          <div className="fineprint asset-hero-meta">
            {[instrument.exchange, instrument.asset_type, instrument.currency]
              .filter(Boolean)
              .join(" • ") || "GLOBAL MARKET"}
            {" • "}
            {quote ? (
              <>
                LIVE · {quote.as_of} UTC
              </>
            ) : (
              <>QUOTE DELAYED</>
            )}
          </div>
        </div>
        <div className="asset-hero-quote">
          <span className="asset-hero-price mono">
            {quote?.price != null ? formatPrice(quote.price) : "—"}
          </span>
          <span className={`mono asset-hero-change ${changeTone}`}>
            {quote?.change != null && `${quote.change > 0 ? "+" : ""}${formatPrice(quote.change)}  `}
            {quote?.change_percent != null &&
              `(${quote.change_percent > 0 ? "+" : ""}${quote.change_percent}%)`}
          </span>
        </div>
        <div className="asset-hero-actions">
          <button
            type="button"
            className="btn accent"
            disabled={!datasetId}
            onClick={() =>
              navigate(`/analysis/fingerprint?dataset=${datasetId}&symbol=${encodeURIComponent(key)}`)
            }
          >
            RUN FULL ANALYSIS
          </button>
        </div>
      </section>

      {/* TABS */}
      <nav className="asset-tabs" aria-label="Asset sections">
        <span className="asset-tab active">OVERVIEW</span>
        {datasetId ? (
          <Link className="asset-tab" to={`/analysis/fingerprint?dataset=${datasetId}&symbol=${encodeURIComponent(key)}`}>
            ANALYSIS
          </Link>
        ) : null}
        <Link className="asset-tab" to={`/news?symbol=${encodeURIComponent(key)}`}>
          NEWS
        </Link>
        <Link className="asset-tab" to={`/compare?symbol=${encodeURIComponent(key)}`}>
          COMPARE
        </Link>
        <Link className="asset-tab" to={`/ai?symbol=${encodeURIComponent(key)}`}>
          AI
        </Link>
      </nav>

      {/* QUOTE + STATS */}
      <div className="grid-side home-row">
        <TerminalPanel
          title="PRICE & STATE"
          subtitle={
            frame
              ? `${frame.dates.length} sessions of cached daily history`
              : undefined
          }
          actions={
            frame ? (
              <button
                type="button"
                className={`chip-btn small${showDrawdown ? " active" : ""}`}
                onClick={() => setShowDrawdown((v) => !v)}
              >
                DRAWDOWN
              </button>
            ) : null
          }
        >
          {timelineData.length > 1 ? (
            <PriceTimeline data={timelineData} height={280} showDrawdown={showDrawdown} />
          ) : pricesQuery.loading ? (
            <LoadingState label="LOADING PRICE HISTORY" />
          ) : (
            <p className="fineprint">Chart unavailable — insufficient history.</p>
          )}
        </TerminalPanel>

        <TerminalPanel title="KEY STATISTICS" flush>
          <div className="stat-grid">
            {stats.map((s) => (
              <div className="stat-tile" key={s.label}>
                <span className="ctx-label">{s.label}</span>
                <span className="mono stat-value">{s.value}</span>
              </div>
            ))}
          </div>
        </TerminalPanel>
      </div>

      {/* INTELLIGENCE + NEWS */}
      <div className="grid-side home-row">
        <FinprixSignal
          datasetId={datasetId}
          summary={summaryQuery.data}
          loading={summaryQuery.loading}
          error={summaryQuery.error?.message}
        />
        <NewsFeed
          category="equities"
          symbols={[key]}
          title={`${key} NEWS`}
          compact={false}
          showTrending={false}
          limit={8}
        />
      </div>

      {data?.status && data.status !== "current" ? (
        <p className="fineprint">
          Market history {data.status === "complete" ? "imported" : "updated"} —
          cached for instant future access.
        </p>
      ) : null}
    </div>
  );
}
