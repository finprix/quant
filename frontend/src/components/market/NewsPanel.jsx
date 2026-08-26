import { useEffect, useState } from "react";
import { request } from "../../api/client.js";
import { TerminalPanel } from "../common/Panels.jsx";
import { LoadingState } from "../states/States.jsx";

/**
 * Provider pass-through headlines for a list of tracked symbols.
 * Owned by DISCOVER surfaces (Markets + Overview command center).
 */
export default function NewsPanel({ symbols, title = "MARKET NEWS" }) {
  const [symbolIndex, setSymbolIndex] = useState(0);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  const symbol = symbols[symbolIndex];

  useEffect(() => {
    setItems(null);
    setError(null);
    if (!symbol) return undefined;
    let alive = true;
    request(`/market/news/${encodeURIComponent(symbol)}`)
      .then((payload) => alive && setItems(payload.items || []))
      .catch((err) => alive && setError(err.message || String(err)));
    return () => {
      alive = false;
    };
  }, [symbol]);

  if (!symbols.length) {
    return (
      <TerminalPanel title={title} flush>
        <p className="fineprint" style={{ padding: "12px 14px" }}>
          Track a symbol to see its recent public headlines.
        </p>
      </TerminalPanel>
    );
  }

  return (
    <TerminalPanel
      title={`${title} — ${symbol}`}
      flush
      actions={
        symbols.length > 1 ? (
          <button
            type="button"
            className="chip-btn"
            onClick={() =>
              setSymbolIndex((i) => (i + 1) % Math.max(1, symbols.length))
            }
          >
            NEXT SYMBOL
          </button>
        ) : null
      }
    >
      {error ? (
        <p className="error-text" style={{ padding: "12px 14px" }}>
          {error}
        </p>
      ) : items == null ? (
        <LoadingState label="LOADING HEADLINES" />
      ) : items.length === 0 ? (
        <p className="fineprint" style={{ padding: "12px 14px" }}>
          No recent headlines.
        </p>
      ) : (
        <div className="news-list">
          {items.map((item) => (
            <a
              key={item.link || item.title}
              className="news-item"
              href={item.link || "#"}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className="news-title">{item.title}</span>
              <span className="news-meta mono fineprint">
                {item.publisher || "provider"} · {item.published ?? ""}
              </span>
            </a>
          ))}
        </div>
      )}
    </TerminalPanel>
  );
}
