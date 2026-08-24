import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { APP_VERSION } from "../../lib/version.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { getWatchlist } from "../../api/watchlist.js";
import GlobalSearch from "./GlobalSearch.jsx";

// Decluttered: seven top-level entries; related pages grouped in dropdowns.
const NAV_GROUPS = [
  { label: "Overview", to: "/", end: true },
  { label: "Markets", to: "/markets" },
  {
    label: "Analysis",
    children: [
      { to: "/fingerprint", label: "Fingerprint" },
      { to: "/analogues", label: "Analogues" },
      { to: "/regimes", label: "Regimes" },
      { to: "/intelligence", label: "Intelligence" },
      { to: "/heatmaps", label: "Heatmaps" },
    ],
  },
  { label: "Compare", to: "/compare" },
  { label: "AI", to: "/ai" },
  { label: "Report", to: "/report" },
  {
    label: "Data",
    children: [
      { to: "/datasets", label: "Datasets" },
      { to: "/database", label: "Database" },
    ],
  },
];

function NavGroup({ group }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location]);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const anyActive = group.children.some((c) => location.pathname === c.to);

  return (
    <div className={`nav-group${anyActive ? " has-active" : ""}`} ref={ref}>
      <button
        type="button"
        className={`nav-pill nav-group-btn${anyActive ? " active" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {group.label} <span className="nav-caret">▾</span>
      </button>
      {open ? (
        <div className="nav-menu">
          {group.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              className={({ isActive }) =>
                `nav-menu-item${isActive ? " active" : ""}`
              }
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
      <GlobalSearch />
      <nav className="topnav-links" aria-label="Primary">
        {NAV_GROUPS.map((group) =>
          group.children ? (
            <NavGroup key={group.label} group={group} />
          ) : (
            <NavLink
              key={group.to}
              to={group.to}
              end={group.end}
              className={({ isActive }) => `nav-pill${isActive ? " active" : ""}`}
            >
              {group.label}
            </NavLink>
          ),
        )}
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
