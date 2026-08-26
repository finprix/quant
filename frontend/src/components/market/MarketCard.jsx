import { Link } from "react-router-dom";

/** Deterministic market-path helper: every symbol routes to its overview. */
export function marketPath(symbol) {
  return `/market/${encodeURIComponent(String(symbol || "").toUpperCase())}`;
}

function fmt(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const num = Number(value);
  if (Math.abs(num) >= 10000)
    return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(num) >= 1000)
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return num.toFixed(digits);
}

export function formatPrice(value) {
  return fmt(value);
}

export function ChangeTag({ value, absolute }) {
  if (value == null) return <span className="mono muted">—</span>;
  const cls = value > 0 ? "pos" : value < 0 ? "neg" : "";
  return (
    <span className={`mono change-tag ${cls}`}>
      {absolute != null && (
        <span className="change-abs">
          {absolute > 0 ? "+" : ""}
          {fmt(absolute)}
        </span>
      )}{" "}
      {value > 0 ? "+" : ""}
      {fmt(value)}%
    </span>
  );
}

/**
 * Compact clickable instrument card — the atomic unit of every board.
 * Renders real provider fields only; unavailable data shows "—".
 */
export default function MarketCard({ row, size = "compact" }) {
  const q = row?.quote;
  if (!row) return null;
  return (
    <Link
      to={marketPath(row.symbol)}
      className={`market-card market-card--${size}`}
      title={`${row.label ?? row.symbol} — open overview`}
    >
      <div className="market-card-top">
        <span className="market-card-label mono">{row.label ?? row.symbol}</span>
        {size !== "compact" && row.region ? (
          <span className="market-card-region fineprint">{row.region}</span>
        ) : null}
      </div>
      {q ? (
        <>
          <div className="market-card-price mono">{formatPrice(q.price)}</div>
          <div className="market-card-change">
            <ChangeTag value={q.change_percent} absolute={q.change} />
          </div>
        </>
      ) : (
        <div className="market-card-price mono muted" title={row.error || ""}>
          UNAVAILABLE
        </div>
      )}
    </Link>
  );
}
