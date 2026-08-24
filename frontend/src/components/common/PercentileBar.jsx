/**
 * Label + horizontal percentile bar (0-100) + numeric readout.
 */
export function PercentileBar({ label, value, format, variant = "" }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="pct-bar-row">
      <span className="metric-label" title={label}>
        {label}
      </span>
      <div className="pct-bar-track">
        <div
          className={`pct-bar-fill${variant === "biscuit" ? " biscuit" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="pct-bar-num">
        {format ? format(value) : `${Math.round(pct)}%`}
      </span>
    </div>
  );
}

export default PercentileBar;
