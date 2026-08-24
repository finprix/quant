import "./ui.css";

export function SectionPanel({ title, subtitle, children, actions, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function StatTile({ label, value, tone, detail }) {
  return (
    <div className={`stat-tile ${tone ? `tone-${tone}` : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail ? <span className="stat-detail">{detail}</span> : null}
    </div>
  );
}

export function KeyValueGrid({ items }) {
  return (
    <dl className="kv-grid">
      {items.map((item) => (
        <div className="kv-row" key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.tone ? `tone-${item.tone}` : undefined}>
            {item.value !== undefined && item.value !== null ? item.value : "N/A"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({ value, kind = "auto" }) {
  if (value === null || value === undefined || value === "") {
    return <span className="badge badge-flat">N/A</span>;
  }
  const lower = String(value).toLowerCase();
  const resolved =
    kind !== "auto"
      ? kind
      : ["bullish", "positive", "up"].some((t) => lower.includes(t))
        ? "up"
        : ["bearish", "negative", "down"].some((t) => lower.includes(t))
          ? "down"
          : ["mixed", "conflict"].some((t) => lower.includes(t))
            ? "warn"
            : "flat";
  return (
    <span
      className={`badge badge-${resolved}`}
      data-value={String(value).toUpperCase()}
    >
      {String(value).toUpperCase()}
    </span>
  );
}

export function DivergingBar({ value, min = -1, max = 1, format }) {
  const blank =
    value === null || value === undefined || !Number.isFinite(Number(value));
  const numeric = blank ? 0 : Number(value);
  const clamped = Math.max(min, Math.min(max, numeric));
  const zeroPct = ((0 - min) / (max - min)) * 100;
  const valuePct = ((clamped - min) / (max - min)) * 100;
  const left = Math.min(zeroPct, valuePct);
  const width = Math.abs(valuePct - zeroPct);
  const positive = clamped >= 0;
  return (
    <div className="diverging-bar" title={format ? format(numeric) : String(numeric)}>
      <span className="diverging-zero" style={{ left: `${zeroPct}%` }} />
      <span
        className={`diverging-fill ${positive ? "fill-up" : "fill-down"}`}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
    </div>
  );
}

export function DataTable({ columns, rows, emptyMessage = "No records." }) {
  if (!rows || rows.length === 0) {
    return (
      <p className="table-empty">{emptyMessage}</p>
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align ? `align-${column.align}` : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key ?? index}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`${column.mono ? "mono" : ""} ${column.align ? `align-${column.align}` : ""}`}
                >
                  {column.render ? column.render(row) : row[column.key] ?? "N/A"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Collapsible({ title, children, defaultOpen = false }) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
