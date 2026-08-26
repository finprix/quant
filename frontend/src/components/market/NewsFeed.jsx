import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getNewsFeed } from "../../api/web.js";
import { TerminalPanel } from "../common/Panels.jsx";
import { LoadingState } from "../states/States.jsx";
import { marketPath } from "./MarketCard.jsx";

function timeOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Aggregated provider headlines with derived trending symbols.
 * Real pass-through data only; clicking an instrument opens its overview.
 */
export default function NewsFeed({
  category = "latest",
  symbols,
  title = "MARKET NEWS",
  limit = 12,
  showTrending = true,
  compact = false,
}) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setPayload(null);
    setError(null);
    getNewsFeed({ category, symbols })
      .then((p) => alive && setPayload(p))
      .catch((err) => alive && setError(err?.message || String(err)));
    return () => {
      alive = false;
    };
  }, [category, symbols]);

  const items = payload?.items ?? [];

  return (
    <TerminalPanel
      title={title}
      subtitle={
        error
          ? "Headlines temporarily unavailable"
          : payload?.as_of
            ? `UPDATED ${timeOf(payload.as_of)} UTC`
            : undefined
      }
      flush={compact}
      actions={
        !compact ? (
          <Link className="chip-btn" to="/news">
            NEWS TERMINAL →
          </Link>
        ) : null
      }
    >
      {error ? (
        <p className="fineprint" style={{ padding: "10px 14px" }}>{error}</p>
      ) : !payload ? (
        <LoadingState label="FETCHING HEADLINES" />
      ) : (
        <>
          {items.length === 0 ? (
            <p className="fineprint" style={{ padding: "10px 14px" }}>
              No recent headlines from available sources.
            </p>
          ) : (
            <div className="news-list">
              {(compact ? items.slice(0, 8) : items).map((item, i) => (
                <div key={`${item.link || item.title}-${i}`} className="news-item">
                  <span className="news-meta-row mono fineprint">
                    {timeOf(item.published)}
                    {item.publisher ? ` · ${item.publisher}` : ""}
                  </span>
                  <a
                    className="news-title"
                    href={item.link || "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {item.title}
                  </a>
                  {item.related_symbol ? (
                    <Link
                      to={marketPath(item.related_symbol)}
                      className="news-symbol mono fineprint"
                    >
                      {item.related_symbol
                        .replace("-USD", "")
                        .replace(".NS", "")
                        .replace("^", "")}{" "}
                      →
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {showTrending && payload.trending?.length ? (
            <div className="trending-row">
              <span className="ctx-label">TRENDING</span>
              {payload.trending.map((t) => (
                <Link
                  key={t.symbol}
                  className="chip-btn small mono"
                  to={marketPath(t.symbol)}
                  title={`${t.stories} stories`}
                >
                  {t.symbol.replace("-USD", "").replace(".NS", "").replace("^", "")}{" "}
                  <span className="fineprint">{t.stories}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </>
      )}
    </TerminalPanel>
  );
}
