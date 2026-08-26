import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { request } from "../../api/client.js";

const POPULAR = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^NSEI", label: "NIFTY 50" },
  { symbol: "NVDA", label: "NVIDIA" },
  { symbol: "AAPL", label: "APPLE" },
  { symbol: "MSFT", label: "MICROSOFT" },
  { symbol: "BTC-USD", label: "BITCOIN" },
  { symbol: "GC=F", label: "GOLD" },
];

/** Deterministic command routing — no NL magic, just prefix verbs. */
function parseCommand(raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("analyze ")) {
    return { verb: "analyze", target: text.slice(8).trim() };
  }
  if (lower.startsWith("news ")) {
    return { verb: "news", target: text.slice(5).trim() };
  }
  const compareMatch = lower.match(/^compare\s+([a-z0-9.\-^=]+)\s+([a-z0-9.\-^=]+)$/);
  if (compareMatch) {
    return {
      verb: "compare",
      a: text.split(/\s+/)[1],
      b: text.split(/\s+/)[2],
    };
  }
  return { verb: "search", target: text };
}

/**
 * FINPRIX COMMAND BAR — Ctrl+K (or /) opens the market palette.
 * Symbol search + quick actions (Overview / Analyze / News) and simple
 * deterministic commands: analyze nvda · news tesla · compare nvda amd.
 */
export default function CommandBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setCursor(0);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Debounced provider search
  useEffect(() => {
    const q = query.trim();
    if (!q || q.includes(" ")) {
      setResults([]);
      return undefined;
    }
    if (q.length < 1) return undefined;
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const payload = await request(
          `/market/search?q=${encodeURIComponent(q)}&provider=yahoo`,
        );
        setResults((payload.results || []).slice(0, 7));
        setCursor(0);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 240);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const parsed = useMemo(() => parseCommand(query), [query]);

  const actionsFor = useCallback(
    (symbol) => [
      { label: `Open ${symbol} overview`, run: () => navigate(`/market/${encodeURIComponent(symbol)}`) },
      { label: `Analyze ${symbol}`, run: () => navigate(`/analysis/fingerprint?symbol=${encodeURIComponent(symbol)}`) },
      { label: `${symbol} news`, run: () => navigate(`/news?symbol=${encodeURIComponent(symbol)}`) },
      { label: `Compare ${symbol}`, run: () => navigate(`/compare?symbol=${encodeURIComponent(symbol)}`) },
    ],
    [navigate],
  );

  const flatItems = useMemo(() => {
    if (parsed.verb !== "search") return [];
    const base = results.length
      ? results
      : query.trim()
        ? [{ symbol: query.trim().toUpperCase(), name: "Go directly" }]
        : POPULAR;
    return base.flatMap((r) =>
      actionsFor(r.symbol).map((action) => ({ ...action, result: r })),
    );
  }, [results, query, parsed.verb, actionsFor]);

  const execute = useCallback(
    (item) => {
      close();
      item.run();
    },
    [close],
  );

  const submit = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    if (parsed.verb === "analyze") {
      close();
      navigate(`/analysis/fingerprint?symbol=${encodeURIComponent(parsed.target.toUpperCase())}`);
    } else if (parsed.verb === "news") {
      close();
      navigate(`/news?symbol=${encodeURIComponent(parsed.target.toUpperCase())}`);
    } else if (parsed.verb === "compare") {
      close();
      navigate(`/compare?symbols=${encodeURIComponent(`${parsed.a},${parsed.b}`.toUpperCase())}`);
    } else if (flatItems[cursor]) {
      execute(flatItems[cursor]);
    }
  }, [query, parsed, flatItems, cursor, close, navigate, execute]);

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 4, Math.max(0, flatItems.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 4));
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="commandbar-trigger mono"
        onClick={() => setOpen(true)}
        aria-label="Open command bar"
        title="Search Finprix (Ctrl+K)"
      >
        <span className="commandbar-hint">SEARCH FINPRIX…</span>
        <kbd>Ctrl K</kbd>
      </button>
    );
  }

  const showPopular = parsed.verb === "search" && !query.trim();

  return (
    <div className="commandbar-overlay" onMouseDown={close}>
      <div
        className="commandbar"
        role="dialog"
        aria-label="Finprix command bar"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="commandbar-input"
          value={query}
          placeholder="Search markets… try 'analyze nvda', 'news tesla', 'compare nvda amd'"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search Finprix"
        />
        {searching ? <span className="fineprint pad">searching…</span> : null}

        <div className="commandbar-list">
          {!showPopular && parsed.verb !== "search" ? (
            <>
              <div className="commandbar-section fineprint">COMMAND</div>
              <button
                type="button"
                className="commandbar-item active"
                onClick={submit}
              >
                {parsed.verb === "analyze" && (
                  <>Analyze <b>{parsed.target?.toUpperCase()}</b> in the Finprix workspace</>
                )}
                {parsed.verb === "news" && (
                  <>Open <b>{parsed.target?.toUpperCase()}</b> news</>
                )}
                {parsed.verb === "compare" && (
                  <>Compare <b>{parsed.a?.toUpperCase()}</b> vs <b>{parsed.b?.toUpperCase()}</b></>
                )}
              </button>
            </>
          ) : null}

          {showPopular ? (
            <div className="commandbar-section fineprint">
              POPULAR MARKETS
            </div>
          ) : null}

          {(showPopular ? results : results).length > 0 && !showPopular ? (
            <div className="commandbar-section fineprint">INSTRUMENTS</div>
          ) : null}

          {(showPopular ? POPULAR : results).map((r, idx) => (
            <div key={`${r.symbol}-${idx}`} className="commandbar-group">
              <div className="commandbar-symbol mono">
                {r.symbol}
                {r.name && r.name !== "Go directly" ? (
                  <span className="fineprint"> · {r.name}</span>
                ) : null}
              </div>
              {actionsFor(r.symbol)
                .slice(0, showPopular ? 1 : 3)
                .map((action, ai) => {
                  const flatIdx = showPopular
                    ? idx
                    : idx * 3 + ai;
                  return (
                    <button
                      key={action.label}
                      type="button"
                      className={`commandbar-item${cursor === flatIdx ? " active" : ""}`}
                      onMouseEnter={() => setCursor(flatIdx)}
                      onClick={() => execute({ run: action.run })}
                    >
                      {action.label}
                    </button>
                  );
                })}
            </div>
          ))}

          {!showPopular && results.length === 0 && query.trim() ? (
            <button
              type="button"
              className="commandbar-item active"
              onClick={() => {
                close();
                navigate(`/market/${encodeURIComponent(query.trim().toUpperCase())}`);
              }}
            >
              Open <b>{query.trim().toUpperCase()}</b> overview directly
            </button>
          ) : null}
        </div>
        <div className="commandbar-foot fineprint">
          ↑↓ navigate · ↵ open · esc close
        </div>
      </div>
    </div>
  );
}
