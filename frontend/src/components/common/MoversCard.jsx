import { Link } from "react-router-dom";
import { formatSignedPercent } from "../../lib/format.js";

/**
 * Finprix-style top gainers / losers card. Shared by the Markets page and
 * the Overview page. Rows deep-link into the quant analysis when a stored
 * dataset exists for the symbol.
 */
export default function MoversCard({ title, rows }) {
  return (
    <div className="market-movers-card">
      <p className={`movers-kicker ${title === "TOP GAINERS" ? "up" : "down"}`}>
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="fineprint">No data yet</p>
      ) : (
        rows.map(({ symbol, quote }) => {
          const target = quote?.dataset_id
            ? `/fingerprint?dataset=${quote.dataset_id}`
            : null;
          return (
            <Link
              key={symbol}
              className="mover-row"
              to={target || "/markets"}
              title={target ? "Open analysis" : "Track or import from Markets"}
            >
              <span className="mono mover-symbol">{symbol}</span>
              <span
                className={`mono mover-pct ${
                  quote?.change_percent >= 0 ? "pos" : "neg"
                }`}
              >
                {quote?.change_percent != null
                  ? formatSignedPercent(quote.change_percent / 100)
                  : "—"}
              </span>
            </Link>
          );
        })
      )}
    </div>
  );
}
