import { NavLink } from "react-router-dom";
import { APP_VERSION } from "../../lib/version.js";
import { useAuth } from "../../context/AuthContext.jsx";

const NAV_ITEMS = [
  { to: "/", label: "Overview", end: true },
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
    </header>
  );
}
