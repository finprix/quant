import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TerminalPanel } from "../common/Panels.jsx";

const MODES = [
  { key: "equities", label: "INDICES" },
  { key: "sectors", label: "SECTORS" },
  { key: "asset-classes", label: "ASSET CLASSES" },
];

function heatColor(pct) {
  if (pct == null) return "var(--heat-zero)";
  const magnitude = Math.min(Math.abs(pct) / 3, 1);
  if (pct > 0)
    return `color-mix(in srgb, var(--heat-pos) ${Math.round(30 + magnitude * 70)}%, var(--heat-zero))`;
  return `color-mix(in srgb, var(--heat-neg) ${Math.round(35 + magnitude * 65)}%, var(--heat-zero))`;
}

function Tile({ row, big }) {
  const pct = row.quote?.change_percent;
  return (
    <Link
      to={`/market/${encodeURIComponent(row.symbol)}`}
      className={`heat-tile${big ? " heat-tile--big" : ""}`}
      style={{ background: heatColor(pct) }}
      title={`${row.label} — open overview`}
    >
      <span className="heat-tile-label mono">{row.label ?? row.symbol}</span>
      <span className="heat-tile-value mono">
        {pct != null ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
      </span>
    </Link>
  );
}

/**
 * Global market heatmap — indices / sectors / asset classes.
 * Burgundy for losses, restrained green for gains. All tiles clickable.
 */
export default function MarketHeatmap({ quotes, sectors }) {
  const [mode, setMode] = useState("equities");

  const rows = useMemo(() => {
    if (mode === "sectors") {
      return (sectors?.sectors || []).map((s) => ({
        symbol: s.symbol,
        label: s.label,
        quote: {
          change_percent:
            s.ret_5d != null
              ? s.ret_5d
              : s.ret_1d,
        },
        big: false,
      }));
    }
    if (!quotes) return [];
    if (mode === "asset-classes") {
      return quotes.filter((q) =>
        ["crypto", "commodity", "fx"].includes(q.group),
      );
    }
    return quotes.filter(
      (q) => q.group === "index" && q.symbol !== "^VIX",
    );
  }, [mode, quotes, sectors]);

  return (
    <TerminalPanel
      title="MARKET HEATMAP"
      subtitle={mode === "sectors" ? "Colored by 5D return" : "Colored by 1D return"}
      flush
      actions={
        <div className="chip-row">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`chip-btn small${mode === m.key ? " active" : ""}`}
              onClick={() => setMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="fineprint" style={{ padding: "12px 14px" }}>
          Heatmap unavailable until market data loads.
        </p>
      ) : (
        <div className="market-heatmap">
          {rows.map((r) => (
            <Tile key={`${r.symbol}`} row={r} big={r.big} />
          ))}
        </div>
      )}
    </TerminalPanel>
  );
}
