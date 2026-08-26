import "./finprix-logo.css";

/**
 * FINPRIX wordmark — pure typography, the brand itself.
 *
 *   fin  = burgundy italic serif (editorial, high contrast)
 *   Prix = strong upright white serif
 *
 * Variants: small | navbar (default) | medium | hero | report.
 * The report variant drops color for print compatibility.
 */
const SIZES = {
  small: "finprix-logo--small",
  navbar: "finprix-logo--navbar",
  medium: "finprix-logo--medium",
  hero: "finprix-logo--hero",
  report: "finprix-logo--report",
};

export default function FinprixLogo({ size = "navbar", className = "" }) {
  return (
    <span
      className={`finprix-logo ${SIZES[size] ?? ""} ${className}`.trim()}
      role="img"
      aria-label="FINPRIX"
    >
      <span className="finprix-fin">fin</span>
      <span className="finprix-prix">Prix</span>
    </span>
  );
}
