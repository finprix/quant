function toneFor(value) {
  if (value === "up" || value === "down" || value === "warn" || value === "biscuit") {
    return value;
  }
  return "";
}

/**
 * Horizontal strip of metric tiles.
 * items: [{ label, value, delta?, tone? }]
 */
export function MetricStrip({ items }) {
  if (!items?.length) return null;
  return (
    <div className="metric-strip">
      {items.map((item) => (
        <div className="metric-tile" key={item.label}>
          <span className="metric-label" title={item.label}>
            {item.label}
          </span>
          <span
            className={`metric-value ${toneFor(item.tone)}`}
            title={String(item.value ?? "")}
          >
            {item.value ?? "—"}
          </span>
          {item.delta ? (
            <span className={`metric-delta ${item.deltaTone || ""}`}>
              {item.delta}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default MetricStrip;
