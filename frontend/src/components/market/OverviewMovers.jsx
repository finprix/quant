import { useEffect, useState } from "react";
import { getWatchlist } from "../../api/watchlist.js";
import MoversCard from "../common/MoversCard.jsx";

const REFRESH_MS = 60_000;

/**
 * Compact gainers/losers pair fed by the watchlist. Shared across the
 * Overview page (with and without a selected dataset) and Markets.
 * Auto-refreshes on the same 60 s cadence as the rest of the terminal.
 */
export default function OverviewMovers() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getWatchlist()
        .then((payload) => alive && setData(payload))
        .catch(() => {});
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!data) return null;
  const hasRows = (data.symbols || []).length > 0;
  if (!hasRows) return null;

  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
      <MoversCard title="TOP GAINERS" rows={data.gainers || []} />
      <MoversCard title="TOP LOSERS" rows={data.losers || []} />
    </div>
  );
}
