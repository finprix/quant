/**
 * Small uppercase badge. tone: up | down | warn | accent | neutral | (default)
 */
export function StatusBadge({ children, tone }) {
  return (
    <span className={`status-badge${tone ? ` ${tone}` : ""}`}>{children}</span>
  );
}

/** Regime chip: "R03 · TRENDING / LOW VOL" */
export function RegimeBadge({ regimeId, label, confidence }) {
  const idText =
    regimeId === null || regimeId === undefined
      ? "?"
      : String(regimeId + 1).padStart(2, "0");
  return (
    <StatusBadge tone="accent">
      R{idText}
      {label ? ` · ${label}` : ""}
      {typeof confidence === "number"
        ? ` · ${(confidence * 100).toFixed(0)}%`
        : ""}
    </StatusBadge>
  );
}

export default StatusBadge;
