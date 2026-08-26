import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TerminalPanel } from "../common/Panels.jsx";
import { marketPath, formatPrice } from "./MarketCard.jsx";
import { LoadingState } from "../states/States.jsx";

const TABS = [
  { key: "us", label: "US" },
  { key: "india", label: "INDIA" },
  { key: "crypto", label: "CRYPTO" },
];

/**
 * TOP MOVERS — gainers / losers / most active with region tabs.
 * Every row is a clickable market object. Real provider data only.
 */
export default function MoversBoard({ data, error }) {
  const [tab, setTab] = useState("us");
  const [side, setSide] = useState("gainers");

  const rows = useMemo(() => {
    if (!data) return [];
    const source =
      side === "losers" ? data.losers : side === "active" ? data.active : data.gainers;
    return (source || []).filter((r) =>
      tab === "us"
        ? r.group === "us"
        : tab === "india"
          ? r.group === "india"
          : r.group === "crypto",
    );
  }, [data, tab, side]);

  return (
    <TerminalPanel
      title="TOP MOVERS"
      subtitle={error ? "Live movers temporarily unavailable" : "Liquid US · India · crypto universe"}
      flush
      actions={
        <div className="chip-row">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`chip-btn${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="mover-side-row">
        {["gainers", "losers", "active"].map((s) => (
          <button
            key={s}
            type="button"
            className={`chip-btn small${side === s ? " active" : ""}`}
            onClick={() => setSide(s)}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>
      {!data && !error ? (
        <LoadingState label="FETCHING MOVERS" />
      ) : rows.length === 0 ? (
        <p className="fineprint" style={{ padding: "10px 14px" }}>
          No mover data for this selection right now.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="dna-table movers-table">
            <thead>
              <tr>
                <th>SYMBOL</th>
                <th className="num">PRICE</th>
                <th className="num">1D %</th>
                <th className="num">VOLUME</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol}>
                  <td>
                    <Link className="mono symbol-link" to={marketPath(r.symbol)}>
                      {r.label ?? r.symbol}
                    </Link>
                  </td>
                  <td className="mono num">{formatPrice(r.quote?.price)}</td>
                  <td
                    className={`mono num ${
                      (r.quote?.change_percent ?? 0) >= 0 ? "pos" : "neg"
                    }`}
                  >
                    {r.quote?.change_percent != null
                      ? `${r.quote.change_percent > 0 ? "+" : ""}${r.quote.change_percent}%`
                      : "—"}
                  </td>
                  <td className="mono num muted">
                    {r.quote?.volume != null
                      ? r.quote.volume.toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TerminalPanel>
  );
}
