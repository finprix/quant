import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { APP_VERSION } from "../../lib/version.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { getWatchlist } from "../../api/watchlist.js";

const NAV_ITEMS = [
  { to: "/", label: "Overview", end: true },
  { to: "/markets", label: "Markets" },
  { to: "/datasets", label: "Datasets" },
  { to: "/fingerprint", label: "Fingerprint" },
  { to: "/analogues", label: "Analogues" },
  { to: "/regimes", label: "Regimes" },
  { to: "/intelligence", label: "Intelligence" },
  { to: "/heatmaps", label: "Heatmaps" },
  { to: "/compare", label: "Compare" },
  { to: "/ai", label: "AI" },
  { to: "/report", label: "Report" },
  { to: "/database", label: "Database" },
];

function TickerStrip() {
  const [ticks, setTicks] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getWatchlist()
        .then((payload) => {
          if (!alive) return;
          setTicks(
            (payload.symbols || [])
              .filter((r) => r.quote)
              .map((r) => ({
                symbol: r.symbol,
                price: r.quote.price,
                pct: r.quote.change_percent,
              })),
          );
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!ticks || ticks.length === 0) return null;
  return (
    <div className="ticker-strip mono" aria-label="Watchlist quotes">
      {ticks.map((t) => (
        <span key={t.symbol} className="tick">
          <span className="tick-symbol">{t.symbol}</span>{" "}
          <span className="tick-price">{t.price}</span>{" "}
          <span className={`tick-pct ${t.pct >= 0 ? "pos" : "neg"}`}>
            {t.pct >= 0 ? "+" : ""}
            {t.pct}%
          </span>
        </span>
      ))}
    </div>
  );
}

export default function TopNav() {
  const { isDeveloper, logout } = useAuth();
  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">QUANT VECTOR</span>
        <span className="brand-version">v{APP_VERSION}</span>
        <span className={`role-chip mono${isDeveloper ? " dev" : ""}`}>
          {isDeveloper ? "DEVELOPER" : "GUEST ACCESS"}
        </span>
      </div>
      <nav className="topnav-links" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-pill${isActive ? " active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <button
        type="button"
        className="btn small role-exit"
        onClick={logout}
        title={isDeveloper ? "Log out of the developer session" : "Exit guest session"}
      >
        {isDeveloper ? "LOG OUT" : "EXIT SESSION"}
      </button>
      <TickerStrip />
    </header>
  );
}
