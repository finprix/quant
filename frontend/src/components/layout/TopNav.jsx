import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { APP_VERSION } from "../../lib/version.js";
import FinprixLogo from "../brand/FinprixLogo.jsx";
import CommandBar from "./CommandBar.jsx";
import useGlobalBoard from "../../hooks/useGlobalBoard.js";
import { marketPath, formatPrice } from "../market/MarketCard.jsx";
import { ANALYSIS_VIEWS } from "../../lib/navigation.js";

// Product hierarchy (v0.20.0): DISCOVER / ANALYZE / RESEARCH / NEWS / DATA.
// Every entry is always interactive — no disabled-looking navigation.
const NAV_GROUPS = [
  {
    label: "DISCOVER",
    children: [
      { to: "/", label: "Overview", match: (p) => p === "/" },
      { to: "/markets", label: "Markets" },
    ],
  },
  {
    label: "ANALYZE",
    children: ANALYSIS_VIEWS.map((v) => ({
      to: `/analysis/${v.key}`,
      label: v.label,
    })),
  },
  {
    label: "RESEARCH",
    children: [
      { to: "/compare", label: "Compare" },
      { to: "/ai", label: "AI Assistant" },
      { to: "/report", label: "Reports" },
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

  const anyActive = group.children.some((c) =>
    c.match ? c.match(location.pathname) : location.pathname.startsWith(c.to),
  );

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
              end={child.to === "/"}
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

/** Live global indices ticker across the top of every page. */
function TickerStrip() {
  const { data } = useGlobalBoard(60_000);
  const ticks = (data?.quotes || []).filter(
    (q) => q.group === "index" && q.quote && q.quote.change_percent != null,
  );
  if (!ticks.length) return null;
  return (
    <div className="ticker-strip mono" aria-label="Global index quotes">
      {ticks.map((t) => (
        <NavLink key={t.symbol} to={marketPath(t.symbol)} className="tick">
          <span className="tick-symbol">{t.label ?? t.symbol}</span>{" "}
          <span className="tick-price">{formatPrice(t.quote.price)}</span>{" "}
          <span
            className={`tick-pct ${t.quote.change_percent >= 0 ? "pos" : "neg"}`}
          >
            {t.quote.change_percent > 0 ? "+" : ""}
            {t.quote.change_percent}%
          </span>
        </NavLink>
      ))}
    </div>
  );
}

export default function TopNav() {
  return (
    <>
      <header className="topnav">
        <div className="brand">
          <NavLink to="/" aria-label="FINPRIX home">
            <FinprixLogo size="navbar" />
          </NavLink>
          <span className="brand-version">v{APP_VERSION}</span>
        </div>
        <nav className="topnav-links" aria-label="Primary">
          {NAV_GROUPS.map((group) => (
            <NavGroup key={group.label} group={group} />
          ))}
          <NavLink
            to="/news"
            className={({ isActive }) => `nav-pill${isActive ? " active" : ""}`}
          >
            NEWS
          </NavLink>
          <NavGroup
            group={{
              label: "DATA",
              children: [
                { to: "/watchlists", label: "Watchlists" },
                { to: "/datasets", label: "Datasets" },
                { to: "/database", label: "Database" },
              ],
            }}
          />
        </nav>
        <CommandBar />
      </header>
      <TickerStrip />
    </>
  );
}
