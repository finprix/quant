import MarketCard from "./MarketCard.jsx";

const GROUPS = [
  { key: "commodity", label: "COMMODITIES" },
  { key: "fx", label: "FX" },
  { key: "crypto", label: "CRYPTO" },
];

/**
 * CROSS-ASSET DASHBOARD — commodities, FX and crypto from the global board.
 * Rates appear only when the provider supplies real yield data (not yet
 * available) — no fabricated numbers.
 */
export default function CrossAssetBoard({ quotes }) {
  if (!quotes) return null;
  return (
    <section className="cross-asset" aria-label="Cross-asset markets">
      {GROUPS.map((g) => {
        const rows = quotes.filter((q) => q.group === g.key);
        if (!rows.length) return null;
        return (
          <div className="asset-group" key={g.key}>
            <div className="asset-group-head fineprint">{g.label}</div>
            <div className="asset-group-cards">
              {rows.map((row) => (
                <MarketCard key={row.symbol} row={row} size="mini" />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
