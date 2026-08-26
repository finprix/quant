import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import {
  loadWatchlists,
  saveWatchlists,
  addSymbol,
  removeSymbol,
  createList,
  deleteList,
  moveSymbol,
} from "../lib/watchlists.js";
import { marketPath } from "../components/market/MarketCard.jsx";
import { request } from "../api/client.js";

function QuoteLine({ symbol }) {
  const [quote, setQuote] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      request(`/market/quote/${encodeURIComponent(symbol)}`)
        .then((q) => alive && (setQuote(q), setFailed(false)))
        .catch(() => alive && setFailed(true));
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [symbol]);

  if (failed) return <span className="fineprint muted">unavailable</span>;
  if (!quote) return <span className="fineprint">…</span>;
  return (
    <span className="mono">
      {quote.price}{" "}
      <span className={`tick-pct ${quote.change_percent >= 0 ? "pos" : "neg"}`}>
        {quote.change_percent != null
          ? `${quote.change_percent > 0 ? "+" : ""}${quote.change_percent}%`
          : ""}
      </span>
    </span>
  );
}

/**
 * WATCHLISTS — user-managed market lists stored in this browser.
 * No account required; symbols are directly routable market objects.
 */
export default function WatchlistsPage() {
  const [lists, setLists] = useState(loadWatchlists);
  const [activeId, setActiveId] = useState(lists[0]?.id);
  const [draft, setDraft] = useState("");
  const [newListName, setNewListName] = useState("");

  useEffect(() => saveWatchlists(lists), [lists]);

  const active = lists.find((l) => l.id === activeId) ?? lists[0];

  const onAdd = (e) => {
    e.preventDefault();
    const symbol = draft.trim().toUpperCase();
    if (!symbol || !active) return;
    setLists((ls) => addSymbol(ls, active.id, symbol));
    setDraft("");
  };

  return (
    <div className="page watchlists-page">
      <SectionHeader
        title="Watchlists"
        desc="Your tracked markets — stored privately in this browser. Every symbol opens its Finprix overview."
        right={
          <form className="watchlist-add-form" onSubmit={onAdd}>
            <input
              className="ai-input"
              value={draft}
              placeholder="ADD SYMBOL — NVDA, ^NSEI, BTC-USD…"
              maxLength={24}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              aria-label="Symbol to add"
            />
            <button type="submit" className="btn accent small" disabled={!draft.trim()}>
              ADD
            </button>
          </form>
        }
      />

      <div className="grid-side">
        <TerminalPanel title="LISTS" flush>
          <div className="wl-lists">
            {lists.map((l) => (
              <div
                key={l.id}
                className={`wl-list-row${l.id === active?.id ? " active" : ""}`}
              >
                <button
                  type="button"
                  className="wl-list-name mono"
                  onClick={() => setActiveId(l.id)}
                >
                  {l.name}
                  <span className="fineprint"> {l.symbols.length}</span>
                </button>
                {lists.length > 1 ? (
                  <button
                    type="button"
                    className="chip-btn danger small"
                    title={`Delete ${l.name}`}
                    onClick={() => {
                      setLists((ls) => deleteList(ls, l.id));
                      if (activeId === l.id) {
                        const rest = ls.filter((x) => x.id !== l.id);
                        setActiveId(rest[0]?.id);
                      }
                    }}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <form
            className="wl-new-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newListName.trim()) return;
              setLists((ls) => {
                const next = createList(ls, newListName);
                setActiveId(next[next.length - 1].id);
                return next;
              });
              setNewListName("");
            }}
          >
            <input
              className="ai-input"
              value={newListName}
              placeholder="NEW LIST NAME"
              maxLength={24}
              onChange={(e) => setNewListName(e.target.value.toUpperCase())}
              aria-label="New list name"
            />
            <button
              type="submit"
              className="chip-btn"
              disabled={!newListName.trim()}
            >
              CREATE
            </button>
          </form>
        </TerminalPanel>

        <TerminalPanel
          title={active ? `${active.name} — SYMBOLS` : "SYMBOLS"}
          subtitle={`${active?.symbols.length ?? 0} tracked`}
          flush
        >
          {!active || active.symbols.length === 0 ? (
            <p className="fineprint" style={{ padding: "10px 14px" }}>
              Nothing here yet — add a symbol above or search with Ctrl+K.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="dna-table">
                <thead>
                  <tr>
                    <th>SYMBOL</th>
                    <th>QUOTE</th>
                    <th className="num">ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {active.symbols.map((sym, i) => (
                    <tr key={sym}>
                      <td>
                        <Link className="mono symbol-link" to={marketPath(sym)}>
                          {sym}
                        </Link>
                      </td>
                      <td><QuoteLine symbol={sym} /></td>
                      <td className="num">
                        <button
                          type="button"
                          className="chip-btn small"
                          title="Move up"
                          onClick={() =>
                            setLists((ls) => moveSymbol(ls, active.id, i, -1))
                          }
                          disabled={i === 0}
                        >
                          ↑
                        </button>{" "}
                        <button
                          type="button"
                          className="chip-btn small"
                          title="Move down"
                          onClick={() =>
                            setLists((ls) => moveSymbol(ls, active.id, i, +1))
                          }
                          disabled={i === active.symbols.length - 1}
                        >
                          ↓
                        </button>{" "}
                        <button
                          type="button"
                          className="chip-btn danger small"
                          title={`Remove ${sym}`}
                          onClick={() =>
                            setLists((ls) => removeSymbol(ls, active.id, sym))
                          }
                        >
                          REMOVE
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TerminalPanel>
      </div>
    </div>
  );
}
