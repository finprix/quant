import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
} from "../api/watchlist.js";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { TerminalPanel, SectionHeader } from "../components/common/Panels.jsx";
import StatusBadge from "../components/common/StatusBadge.jsx";
import { LoadingState } from "../components/states/States.jsx";
import { formatSignedPercent } from "../lib/format.js";

const REFRESH_MS = 60_000;

function pctClass(value) {
  if (value == null) return "";
  return value >= 0 ? "pos" : "neg";
}

function MoversCard({ title, rows }) {
  return (
    <div className="market-movers-card">
      <p className={`movers-kicker ${title === "TOP GAINERS" ? "up" : "down"}`}>
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="fineprint">No data yet</p>
      ) : (
        rows.map(({ symbol, quote }) => (
          <Link
            key={symbol}
            className="mover-row"
            to={`/fingerprint?dataset=${quote.dataset_id ?? ""}`}
            onClick={(e) => !quote.dataset_id && e.preventDefault()}
            title={quote.dataset_id ? "Open analysis" : "Import to analyse"}
          >
            <span className="mono mover-symbol">{symbol}</span>
            <span className={`mono mover-pct ${pctClass(quote.change_percent)}`}>
              {formatSignedPercent(quote.change_percent / 100)}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}

export default function MarketsPage() {
  const { isDeveloper } = useAuth();
  const { datasets } = useDatasets();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const payload = await getWatchlist();
      // Merge stored dataset ids by symbol so rows can deep-link into the
      // existing quant analysis pages.
      const bySymbol = new Map(
        (payload.symbols || []).map((row) => [row.symbol, row]),
      );
      for (const d of datasets) {
        const source = d.filename?.match(/^([A-Z0-9.\-^=]+)_/i);
        if (!source) continue;
        const sym = source[1].toUpperCase();
        const row = bySymbol.get(sym);
        if (row && row.quote && row.quote.dataset_id == null) {
          row.quote.dataset_id = d.id;
        }
      }
      setData(payload);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [datasets]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const add = async (event) => {
    event.preventDefault();
    const symbol = draft.trim().toUpperCase();
    if (!symbol || busy) return;
    setBusy(true);
    try {
      await addToWatchlist(symbol);
      setDraft("");
      await load();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = useCallback(
    async (symbol) => {
      if (busy) return;
      setBusy(true);
      try {
        await removeFromWatchlist(symbol);
        await load();
      } catch (err) {
        setError(err.message || String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const movers = useMemo(() => {
    if (!data) return { gainers: [], losers: [] };
    return { gainers: data.gainers || [], losers: data.losers || [] };
  }, [data]);

  return (
    <div className="page">
      <SectionHeader
        title="Markets"
        desc="Tracked symbols with live quotes — click a tracked instrument to open its quant analysis."
        right={
          updatedAt ? (
            <StatusBadge tone="up">
              LIVE · updated{" "}
              {updatedAt.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </StatusBadge>
          ) : null
        }
      />

      {error ? (
        <>
          <TerminalPanel title="MARKETS UNAVAILABLE">
            <p className="error-text">{error}</p>
          </TerminalPanel>
          <p className="fineprint">
            Live quotes are temporarily unavailable. Tracked symbols and every
            stored dataset remain fully usable.
          </p>
        </>
      ) : null}

      <div className="grid-side" style={{ alignItems: "start", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <MoversCard title="TOP GAINERS" rows={movers.gainers} />
          <MoversCard title="TOP LOSERS" rows={movers.losers} />
        </div>

        <TerminalPanel title="TRACK A SYMBOL" flush>
          <form className="watchlist-add-form" onSubmit={add}>
            <input
              className="ai-input"
              value={draft}
              placeholder={isDeveloper ? "AAPL, ^GSPC, BTC-USD …" : "Developer access required"}
              disabled={!isDeveloper || busy}
              maxLength={24}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
            />
            <button
              type="submit"
              className="btn accent small"
              disabled={!isDeveloper || busy || !draft.trim()}
            >
              {busy ? "…" : "TRACK"}
            </button>
          </form>
          <p className="fineprint">
            {isDeveloper
              ? "Tracking persists in the database; quotes refresh every 60 seconds."
              : "Adding and removing symbols is a developer action — viewing stays open."}
          </p>
        </TerminalPanel>
      </div>

      <TerminalPanel
        title="WATCHLIST"
        subtitle={
          data
            ? `${(data.symbols || []).length} tracked symbol(s)`
            : undefined
        }
        flush
      >
        {!data ? (
          <LoadingState label="FETCHING QUOTES" />
        ) : (data.symbols || []).length === 0 ? (
          <p className="fineprint">
            Nothing tracked yet{isDeveloper ? " — add a symbol above." : "."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="dna-table watch-table">
              <thead>
                <tr>
                  <th>SYMBOL</th>
                  <th className="num">PRICE</th>
                  <th className="num">CHANGE</th>
                  <th className="num">CHANGE %</th>
                  <th className="num">PREV CLOSE</th>
                  <th>AS OF</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data.symbols || []).map(({ symbol, quote, quote_error }) => {
                  const dataset = datasets.find(
                    (d) =>
                      quote &&
                      quote.dataset_id != null &&
                      d.id === Number(quote.dataset_id),
                  );
                  return (
                    <tr key={symbol}>
                      <td className="mono">{symbol}</td>
                      {quote_error ? (
                        <td colSpan={5}>
                          <span className="error-text">
                            Live market data temporarily unavailable.
                          </span>
                        </td>
                      ) : (
                        <>
                          <td className="mono num">{quote.price}</td>
                          <td className={`mono num ${pctClass(quote.change)}`}>
                            {quote.change ?? "—"}
                          </td>
                          <td className={`mono num ${pctClass(quote.change_percent)}`}>
                            {quote.change_percent != null
                              ? `${quote.change_percent > 0 ? "+" : ""}${quote.change_percent}%`
                              : "—"}
                          </td>
                          <td className="mono num">{quote.previous_close ?? "—"}</td>
                          <td className="mono fineprint">{quote.as_of}</td>
                        </>
                      )}
                      <td className="num">
                        {dataset ? (
                          <Link
                            className="chip-btn"
                            to={`/fingerprint?dataset=${dataset.id}`}
                          >
                            ANALYZE
                          </Link>
                        ) : null}
                        {isDeveloper ? (
                          <button
                            type="button"
                            className="chip-btn danger"
                            disabled={busy}
                            onClick={() => remove(symbol)}
                          >
                            REMOVE
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </TerminalPanel>
    </div>
  );
}
