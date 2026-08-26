import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SectionHeader } from "../components/common/Panels.jsx";
import NewsFeed from "../components/market/NewsFeed.jsx";
import { loadWatchlists } from "../lib/watchlists.js";

const CATEGORIES = [
  { key: "latest", label: "LATEST" },
  { key: "equities", label: "EQUITIES" },
  { key: "macro", label: "MACRO" },
  { key: "crypto", label: "CRYPTO" },
  { key: "commodities", label: "COMMODITIES" },
  { key: "india", label: "INDIA" },
];

/**
 * NEWS TERMINAL — first-class Finprix market news.
 * Aggregated real provider headlines by category; WATCHLIST merges the
 * user's local lists; a focused symbol view opens via /news?symbol=X.
 */
export default function NewsTerminalPage() {
  const [params] = useSearchParams();
  const focusSymbol = params.get("symbol");
  const [tab, setTab] = useState("latest");

  const watchSymbols = useMemo(() => {
    if (!focusSymbol) {
      return [
        ...new Set(
          loadWatchlists().flatMap((l) => l.symbols),
        ),
      ].slice(0, 12);
    }
    return undefined;
  }, [focusSymbol]);

  const category = focusSymbol ? undefined : tab;

  return (
    <div className="page news-page">
      <SectionHeader
        title="Market News"
        desc="Aggregated public headlines from financial news providers — passed through verbatim, never generated."
        right={
          focusSymbol ? (
            <span className="chip-btn active mono">{focusSymbol}</span>
          ) : null
        }
      />

      {!focusSymbol ? (
        <div className="chip-row news-tabs">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`chip-btn${tab === c.key ? " active" : ""}`}
              onClick={() => setTab(c.key)}
            >
              {c.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip-btn${tab === "watchlist" ? " active" : ""}`}
            onClick={() => setTab("watchlist")}
          >
            WATCHLIST
          </button>
        </div>
      ) : null}

      {focusSymbol ? (
        <NewsFeed
          category="equities"
          symbols={[focusSymbol.toUpperCase()]}
          title={`${focusSymbol.toUpperCase()} NEWS`}
          showTrending={false}
          limit={20}
        />
      ) : tab === "watchlist" ? (
        watchSymbols.length > 0 ? (
          <NewsFeed
            category="equities"
            symbols={watchSymbols}
            title="WATCHLIST NEWS"
            limit={24}
          />
        ) : (
          <p className="fineprint">
            Your watchlists are empty — add symbols from the{" "}
            <a href="/watchlists" style={{ color: "var(--accent)" }}>
              Watchlists
            </a>{" "}
            page to follow their stories here.
          </p>
        )
      ) : (
        <NewsFeed category={category} title={`${tab.toUpperCase()} NEWS`} limit={30} />
      )}
    </div>
  );
}
