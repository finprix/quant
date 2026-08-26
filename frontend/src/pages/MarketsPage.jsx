import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  addToWatchlist,
  removeFromWatchlist,
} from "../api/watchlist.js";
import { useAuth } from "../context/AuthContext.jsx";
import { TerminalPanel, SectionHeader } from "../components/common/Panels.jsx";
import StatusBadge from "../components/common/StatusBadge.jsx";
import { LoadingState } from "../components/states/States.jsx";
import MoversCard from "../components/common/MoversCard.jsx";
import NewsPanel from "../components/market/NewsPanel.jsx";
import useSymbolImport from "../hooks/useSymbolImport.js";
import useWatchlistData from "../hooks/useWatchlistData.js";
import { analysisPath } from "../lib/navigation.js";
import { formatRelativeTime } from "../lib/format.js";

const REFRESH_MS = 60_000;

function pctClass(value) {
  if (value == null) return "";
  return value >= 0 ? "pos" : "neg";
}

function compactVolume(value) {
  if (value == null) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

/**
 * MARKETS — discovery only (v0.19.0 ownership model).
 * Find something interesting here; understand it in /analysis/*.
 */
export default function MarketsPage() {
  const { isDeveloper } = useAuth();
  const navigate = useNavigate();
  const [launchingSym, setLaunchingSym] = useState(null);
  const { launch, phase, stage } = useSymbolImport({
    onComplete: (datasetId) => navigate(analysisPath("fingerprint", datasetId)),
  });
  const importing = phase === "importing";

  const { rows, gainers, losers, error, updatedAt, reload } =
    useWatchlistData({ pollMs: REFRESH_MS });

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const add = async (event) => {
    event.preventDefault();
    const symbol = draft.trim().toUpperCase();
    if (!symbol || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await addToWatchlist(symbol);
      setDraft("");
      await reload();
    } catch (err) {
      setActionError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (symbol) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await removeFromWatchlist(symbol);
      await reload();
    } catch (err) {
      setActionError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const openAnalysis = (row) => {
    if (row.stored) navigate(analysisPath("fingerprint", row.stored.id));
  };

  return (
    <div className="page">
      <SectionHeader
        title="Markets"
        desc="Discovery: track symbols, watch live quotes and movers, then jump into the analysis workspace."
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

      {actionError ? (
        <TerminalPanel title="ACTION FAILED" className="">
          <p className="error-text">{actionError}</p>
        </TerminalPanel>
      ) : null}

      <div className="grid-side" style={{ alignItems: "start", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <MoversCard title="TOP GAINERS" rows={gainers} />
          <MoversCard title="TOP LOSERS" rows={losers} />
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
        subtitle={rows ? `${rows.length} tracked symbol(s)` : undefined}
        flush
      >
        {!rows ? (
          <LoadingState label="FETCHING QUOTES" />
        ) : rows.length === 0 ? (
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
                  <th className="num">1D %</th>
                  <th className="num">VOLUME</th>
                  <th>STORED</th>
                  <th>LAST ANALYSIS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const { symbol, quote, quote_error, stored } = row;
                  return (
                    <tr key={symbol}>
                      <td className="mono">
                        <button
                          type="button"
                          className={`link-btn${stored ? "" : " muted"}`}
                          onClick={() => openAnalysis(row)}
                          disabled={!stored}
                          title={
                            stored
                              ? `Open ${symbol} in the analysis workspace`
                              : "Import history to enable analysis"
                          }
                        >
                          {symbol}
                        </button>
                      </td>
                      {quote_error ? (
                        <>
                          <td colSpan={3}>
                            <span className="error-text">
                              Live market data temporarily unavailable.
                            </span>
                          </td>
                          <td>—</td>
                        </>
                      ) : (
                        <>
                          <td className="mono num">{quote.price}</td>
                          <td className={`mono num ${pctClass(quote.change_percent)}`}>
                            {quote.change_percent != null
                              ? `${quote.change_percent > 0 ? "+" : ""}${quote.change_percent}%`
                              : "—"}
                          </td>
                          <td className="mono num">{compactVolume(quote.volume)}</td>
                        </>
                      )}
                      <td className="mono fineprint">
                        {stored ? `#${stored.id} · ${stored.row_count?.toLocaleString()}r` : "—"}
                      </td>
                      <td className="fineprint">
                        {row.last_analysis_ts ? formatRelativeTime(row.last_analysis_ts) : "—"}
                      </td>
                      <td className="num">
                        {stored ? (
                          <Link
                            className="chip-btn"
                            to={analysisPath("fingerprint", stored.id)}
                          >
                            ANALYZE
                          </Link>
                        ) : isDeveloper ? (
                          <button
                            type="button"
                            className="chip-btn"
                            disabled={importing}
                            onClick={() => {
                              setLaunchingSym(symbol.toUpperCase());
                              launch(symbol);
                            }}
                            title="Import history and open the quant analysis"
                          >
                            {importing && launchingSym === symbol.toUpperCase()
                              ? stage || "IMPORTING…"
                              : "IMPORT & ANALYZE"}
                          </button>
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

      <div className="grid-side">
        <NewsPanel symbols={(rows || []).map((r) => r.symbol)} />
        <TerminalPanel title="ABOUT LIVE DATA" flush>
          <p className="fineprint" style={{ padding: "12px 14px" }}>
            Quotes refresh every 60 seconds through a cached provider layer.
            Headlines are public items passed through from the provider —
            Quant Vector does not generate news. Historical analysis always
            uses the stored dataset, never the live tick.
          </p>
        </TerminalPanel>
      </div>
    </div>
  );
}
