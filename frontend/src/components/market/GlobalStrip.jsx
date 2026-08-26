import MarketCard from "./MarketCard.jsx";

const REGIONS = ["US", "INDIA", "EUROPE", "ASIA"];

/**
 * GLOBAL MARKET STRIP — institutional index board across regions.
 * Every card is a clickable market object.
 */
export default function GlobalStrip({ quotes }) {
  if (!quotes) return null;
  return (
    <section className="global-strip" aria-label="Global markets">
      {REGIONS.map((region) => {
        const rows = quotes.filter(
          (q) => q.group === "index" && q.region === region,
        );
        if (!rows.length) return null;
        return (
          <div className="strip-region" key={region}>
            <div className="strip-region-head fineprint">{region}</div>
            <div className="strip-cards">
              {rows.map((row) => (
                <MarketCard key={row.symbol} row={row} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
