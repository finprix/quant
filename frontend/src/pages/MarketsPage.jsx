import { useMemo } from "react";
import { Link } from "react-router-dom";
import { SectionHeader } from "../components/common/Panels.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import useGlobalBoard from "../hooks/useGlobalBoard.js";
import { useApiData } from "../hooks/useApiData.js";
import GlobalStrip from "../components/market/GlobalStrip.jsx";
import MoversBoard from "../components/market/MoversBoard.jsx";
import CrossAssetBoard from "../components/market/CrossAssetBoard.jsx";
import MarketHeatmap from "../components/market/MarketHeatmap.jsx";
import NewsFeed from "../components/market/NewsFeed.jsx";

/**
 * MARKETS — discovery hub (v0.20.0).
 * Global boards, movers, cross-asset context. Every instrument routes to
 * its overview; deep quant lives one click away in /analysis.
 */
export default function MarketsPage() {
  const board = useGlobalBoard(60_000);
  const moversQuery = useApiData("/market/movers");
  const sectorsQuery = useApiData("/sectors");

  const quotes = board.data?.quotes;
  const freshness = board.updatedAt
    ? `LIVE · ${board.updatedAt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "CONNECTING…";

  return (
    <div className="page markets-hub">
      <SectionHeader
        title="Markets"
        desc="Discovery across global equities, indices, commodities, FX and crypto. Click any market to open its overview."
        right={
          <StatusBadge tone={board.error ? "down" : "up"}>{freshness}</StatusBadge>
        }
      />

      <GlobalStrip quotes={quotes} />

      <div className="grid-2 home-row">
        <MoversBoard data={moversQuery.data} error={moversQuery.error?.message} />
        <MarketHeatmap quotes={quotes} sectors={sectorsQuery.data} />
      </div>

      <CrossAssetBoard quotes={quotes} />

      <div className="grid-side home-row">
        <NewsFeed category="latest" title="MARKET NEWS" compact limit={10} />
        <div>
          <p className="fineprint" style={{ marginBottom: 8 }}>
            Deep quantitative analysis — fingerprinting, analogues, regimes and
            intelligence — lives in the{" "}
            <Link to="/analysis/fingerprint" style={{ color: "var(--accent)" }}>
              ANALYZE workspace
            </Link>
            . Track markets in{" "}
            <Link to="/watchlists" style={{ color: "var(--accent)" }}>
              Watchlists
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
