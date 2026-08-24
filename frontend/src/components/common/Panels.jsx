/** Research-terminal panel with uppercase section header. */
export function TerminalPanel({ title, subtitle, actions, flush = false, className = "", children }) {
  return (
    <section className={`panel ${className}`}>
      {title ? (
        <header className="panel-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="panel-title">{title}</h2>
            {subtitle ? <div className="panel-sub">{subtitle}</div> : null}
          </div>
          {actions ? <div className="chip-row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`panel-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

/** Page-level header: big condensed title + description + rule. */
export function SectionHeader({ title, desc, right }) {
  return (
    <>
      <div className="section-header">
        <h1>{title}</h1>
        {desc ? <span className="section-desc">{desc}</span> : null}
        {right ? <div style={{ marginLeft: "auto" }}>{right}</div> : null}
      </div>
      <hr className="section-rule" />
    </>
  );
}
