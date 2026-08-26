import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useApiData } from "../hooks/useApiData.js";
import useGlobalBoard from "../hooks/useGlobalBoard.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import FinprixLogo from "../components/brand/FinprixLogo.jsx";
import GlobalStrip from "../components/market/GlobalStrip.jsx";
import MarketPulse from "../components/market/MarketPulse.jsx";
import MoversBoard from "../components/market/MoversBoard.jsx";
import CrossAssetBoard from "../components/market/CrossAssetBoard.jsx";
import SectorTable from "../components/market/SectorTable.jsx";
import MarketHeatmap from "../components/market/MarketHeatmap.jsx";
import NewsFeed from "../components/market/NewsFeed.jsx";
import { loadWatchlists } from "../lib/watchlists.js";

/**
 * FINPRIX — GLOBAL MARKET COMMAND CENTER (v0.20.0).
 * Web-first homepage: useful immediately with zero datasets, no selected
 * symbol and no history. Every market object is clickable.
 */
export default function HomePage() {
  const board = useGlobalBoard(60_000);
  const moversQuery = useApiData("/market/movers");
  const sectorsQuery = useApiData("/sectors");

  const watchSymbols = useMemo(() => {
    const lists = loadWatchlists();
    return lists[0]?.symbols ?? [];
  }, []);

  const quotes = board.data?.quotes;
  const freshness = board.updatedAt
    ? `LIVE · ${board.updatedAt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "CONNECTING…";

  return (
    <div className="page home-page">
      <section className="home-hero">
        <div>
          <FinprixLogo size="medium" />
          <h1 className="home-title">GLOBAL MARKET COMMAND CENTER</h1>
          <p className="home-sub fineprint">
            Live global markets, cross-asset context and evidence-based
            quantitative intelligence — statistical fingerprinting, historical
            analogues, regime discovery.
          </p>
        </div>
        <div className="home-hero-side">
          <StatusBadge tone={board.error ? "down" : "up"}>{freshness}</StatusBadge>
          <Link to="/markets" className="btn small">EXPLORE MARKETS</Link>
        </div>
      </section>

      {board.error ? (
        <TerminalPanel title="MARKET DATA UNAVAILABLE" flush>
          <p className="error-text" style={{ padding: "10px 14px" }}>
            {board.error}
          </p>
          <p className="fineprint" style={{ padding: "0 14px 10px" }}>
            The provider layer could not be reached. Retry shortly — every
            other Finprix surface remains available.
          </p>
        </TerminalPanel>
      ) : null}

      {/* GLOBAL MARKET TICKER STRIP */}
      <GlobalStrip quotes={quotes} />

      {/* PULSE + HEATMAP */}
      <div className="grid-2 home-row">
        <MarketPulse quotes={quotes} />
        <MarketHeatmap quotes={quotes} sectors={sectorsQuery.data} />
      </div>

      {/* MOVERS + SECTORS */}
      <div className="grid-2 home-row">
        <MoversBoard data={moversQuery.data} error={moversQuery.error?.message} />
        <SectorTable data={sectorsQuery.data} error={sectorsQuery.error?.message} />
      </div>

      {/* CROSS-ASSET */}
      <CrossAssetBoard quotes={quotes} />

      {/* NEWS + WORKSPACE */}
      <div className="grid-side home-row">
        <NewsFeed category="latest" title="MARKET NEWS" compact limit={12} />
        <TerminalPanel title="FINPRIX WORKSPACE" subtitle="Where to go next">
          <div className="workspace-links">
            <Link className="ws-link" to="/analysis/fingerprint">
              <span className="ws-title mono">ANALYZE</span>
              <span className="fineprint">
                Statistical fingerprint · analogues · regimes · intelligence for any symbol
              </span>
            </Link>
            <Link className="ws-link" to="/compare">
              <span className="ws-title mono">COMPARE</span>
              <span className="fineprint">
                Cross-market fingerprints, correlations and beta
              </span>
            </Link>
            <Link className="ws-link" to="/watchlists">
              <span className="ws-title mono">WATCHLISTS</span>
              <span className="fineprint">
                Your tracked markets — stored in this browser
              </span>
            </Link>
            {watchSymbols.length > 0 ? (
              <div className="ctx-item">
                <span className="ctx-label">WATCHING</span>
                <span className="mono">{watchSymbols.slice(0, 8).join(" · ")}</span>
              </div>
            ) : null}
          </div>
        </TerminalPanel>
      </div>
    </div>
  );
}
