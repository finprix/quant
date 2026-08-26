import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client.js";
import useSymbolImport from "../../hooks/useSymbolImport.js";
import { fingerprintPath } from "../../lib/navigation.js";

/**
 * Finprix-style global symbol search in the top bar.
 * Debounced provider lookup -> quote preview with Track / Import actions.
 */
export default function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [tracked, setTracked] = useState(false);
  const boxRef = useRef(null);
  const debounceRef = useRef(null);
  const { launch, phase, stage } = useSymbolImport({
    onComplete: (datasetId) => {
      setSelected(null);
      window.location.assign(fingerprintPath(datasetId));
    },
  });

  // close on outside click
  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setResults([]);
        setSelected(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // debounced search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return undefined;
    }
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const payload = await request(
          `/market/search?q=${encodeURIComponent(q)}&provider=yahoo`,
        );
        setResults((payload.results || []).slice(0, 6));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 260);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const pick = async (result) => {
    setResults([]);
    setQuery(result.symbol);
    setSelected(result);
    setQuote(null);
    setQuoteError(null);
    setTracked(false);
    try {
      const q = await request(
        `/market/quote/${encodeURIComponent(result.symbol)}`,
      );
      setQuote(q);
    } catch (err) {
      setQuoteError(err?.message || "Quote unavailable.");
    }
  };

  const track = async () => {
    if (!selected) return;
    try {
      await request("/watchlist", {
        method: "POST",
        body: { symbol: selected.symbol },
      });
      setTracked(true);
    } catch (err) {
      setQuoteError(err?.message || "Could not track symbol.");
    }
  };

  const importing = phase === "importing";

  return (
    <div className="global-search" ref={boxRef}>
      <input
        className="ai-input global-search-input"
        value={query}
        placeholder="Search markets…"
        aria-label="Search markets"
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching ? <span className="gs-hint">…</span> : null}

      {results.length > 0 ? (
        <div className="gs-menu">
          {results.map((r) => (
            <button
              key={`${r.symbol}-${r.name}`}
              type="button"
              className="gs-row"
              onClick={() => pick(r)}
            >
              <span className="mono gs-symbol">{r.symbol}</span>
              <span className="gs-name">{r.name || r.symbol}</span>
            </button>
          ))}
        </div>
      ) : null}

      {selected ? (
        <div className="gs-menu gs-preview">
          {quoteError ? (
            <p className="error-text">{quoteError}</p>
          ) : quote ? (
            <>
              <p className="mono gs-quote-line">
                {quote.symbol} · {quote.price}{" "}
                <span className={`tick-pct ${quote.change_percent >= 0 ? "pos" : "neg"}`}>
                  {quote.change_percent >= 0 ? "+" : ""}
                  {quote.change_percent}%
                </span>
              </p>
              <div className="row-actions">
                <button type="button" className="btn small" onClick={track}
                        disabled={tracked}>
                  {tracked ? "TRACKED" : "TRACK"}
                </button>
                <button
                  type="button"
                  className="btn accent small"
                  disabled={importing}
                  onClick={() => launch(selected.symbol)}
                >
                  {importing ? stage || "IMPORTING…" : "IMPORT & ANALYZE"}
                </button>
              </div>
            </>
          ) : (
            <p className="fineprint">Fetching quote…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
