import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getDbSchema,
  getDbRows,
  getDbStats,
  getDbStatus,
  getDbTables,
  getDatasetStorage,
  runIntegrityCheck,
  runRawQuery,
} from "../api/database.js";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import { EmptyState, LoadingState } from "../components/states/States.jsx";
import { formatDate, formatInteger } from "../lib/format.js";

const RELATIONSHIPS = [
  { table: "price_data", label: "price_data — OHLCV observations", depth: 1 },
  { table: "dataset_sources", label: "dataset_sources — provenance (1:1)", depth: 1 },
  { table: "analysis_results", label: "analysis_results — summary cache", depth: 1 },
  { table: "fingerprints", label: "fingerprints — fingerprint cache", depth: 1 },
  { table: "analogue_matches", label: "analogue_matches — analogues", depth: 1 },
  { table: "regime_models", label: "regime_models — regime engines", depth: 1 },
  { table: "regime_assignments", label: "regime_assignments — windows", depth: 2 },
  { table: "intelligence_snapshots", label: "intelligence_snapshots", depth: 1 },
];

const LINEAGE_TAIL = [
  "Normalizer",
  "MySQL · price_data",
  "Fingerprint",
  "Regimes",
  "Analogues",
  "Intelligence",
  "AI / Frontend",
];

function Lineage({ source }) {
  const head = source
    ? [
        String(source.provider ?? "provider").toUpperCase(),
        source.provider === "yahoo" ? "yfinance" : "provider client",
        "MarketDataSource",
      ]
    : ["CSV FILE", "CSV parser"];
  const steps = [...head, ...LINEAGE_TAIL];
  return (
    <div className="db-lineage">
      {steps.map((step, index) => (
        <div key={`${step}-${index}`} className="db-lineage-item">
          <span className={`db-lineage-step${index === 0 ? " origin" : ""}`}>
            {step}
          </span>
          {index < steps.length - 1 ? (
            <span className="db-lineage-arrow">▼</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="metric-tile">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TableViewer({ name, meta, initialFilters, onOpenTable }) {
  const [schema, setSchema] = useState(null);
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState({ by: null, dir: "asc" });
  const [filters, setFilters] = useState(initialFilters ?? {});
  const [draft, setDraft] = useState(initialFilters ?? {});
  const [showSchema, setShowSchema] = useState(false);

  const columnNames = useMemo(
    () => (schema?.columns ?? []).map((c) => c.name),
    [schema],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = {
      limit,
      offset,
      ...(sort.by ? { order_by: sort.by, order_dir: sort.dir } : {}),
      ...Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v !== "" && v != null),
      ),
    };
    Promise.all([getDbSchema(name), getDbRows(name, query)])
      .then(([schemaData, rowData]) => {
        if (cancelled) return;
        setSchema(schemaData);
        setPage(rowData);
      })
      .catch((err) => !cancelled && setError(err.message || String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [name, limit, offset, sort, filters]);

  const applyFilters = (event) => {
    event.preventDefault();
    setFilters(draft);
    setOffset(0);
  };

  const toggleSort = (column) => {
    setSort((prev) =>
      prev.by === column
        ? prev.dir === "asc"
          ? { by: column, dir: "desc" }
          : { by: null, dir: "asc" }
        : { by: column, dir: "asc" },
    );
    setOffset(0);
  };

  const numericColumns = useMemo(() => {
    if (!schema) return new Set();
    return new Set(
      schema.columns
        .filter((c) => /int|double|decimal|float/i.test(c.type))
        .map((c) => c.name),
    );
  }, [schema]);

  const totalPages = page ? Math.max(1, Math.ceil(page.total / limit)) : 1;
  const currentPage = Math.floor(offset / limit) + 1;
  const rangeStart = page && page.total > 0 ? offset + 1 : 0;
  const rangeEnd = page ? Math.min(offset + limit, page.total) : 0;

  const hasColumn = (col) => columnNames.includes(col);

  return (
    <TerminalPanel
      title={`TABLE — ${name.toUpperCase()}`}
      subtitle={
        page
          ? `${formatInteger(page.total)} row${page.total === 1 ? "" : "s"} in MySQL${
              Object.keys(filters).length
                ? ` · filtered (${Object.entries(filters)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ")})`
                : ""
            }`
          : undefined
      }
      actions={
        <button
          type="button"
          className={`chip-btn${showSchema ? " active" : ""}`}
          onClick={() => setShowSchema((prev) => !prev)}
        >
          SCHEMA
        </button>
      }
    >
      {/* filter bar */}
      <form className="db-filter-bar" onSubmit={applyFilters}>
        {hasColumn("dataset_id") ? (
          <label className="control-inline">
            DATASET_ID
            <input
              className="ai-input db-filter-input"
              style={{ maxWidth: 110 }}
              value={draft.dataset_id ?? ""}
              placeholder="all"
              onChange={(e) =>
                setDraft({ ...draft, dataset_id: e.target.value })
              }
            />
          </label>
        ) : null}
        {hasColumn("date") ? (
          <>
            <label className="control-inline">
              FROM
              <input
                type="date"
                className="date-input"
                value={draft.date_from ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, date_from: e.target.value })
                }
              />
            </label>
            <label className="control-inline">
              TO
              <input
                type="date"
                className="date-input"
                value={draft.date_to ?? ""}
                onChange={(e) => setDraft({ ...draft, date_to: e.target.value })}
              />
            </label>
          </>
        ) : null}
        {hasColumn("symbol") ? (
          <label className="control-inline">
            SYMBOL
            <input
              className="ai-input db-filter-input"
              style={{ maxWidth: 110 }}
              value={draft.symbol ?? ""}
              placeholder="all"
              onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
            />
          </label>
        ) : null}
        {hasColumn("provider") ? (
          <label className="control-inline">
            PROVIDER
            <input
              className="ai-input db-filter-input"
              style={{ maxWidth: 110 }}
              value={draft.provider ?? ""}
              placeholder="all"
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
            />
          </label>
        ) : null}
        <select
          className="date-input"
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            setOffset(0);
          }}
        >
          {[25, 50, 100, 250, 500].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <button type="submit" className="btn small accent">
          APPLY
        </button>
        {Object.keys(filters).some((k) => filters[k]) ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setDraft({});
              setFilters({});
              setOffset(0);
            }}
          >
            CLEAR
          </button>
        ) : null}
      </form>

      {showSchema && schema ? (
        <div className="db-schema">
          <div className="db-schema-block">
            <h4>COLUMNS</h4>
            <table className="dna-table compact">
              <thead>
                <tr>
                  <th>column</th>
                  <th>type</th>
                  <th>null</th>
                  <th>key</th>
                </tr>
              </thead>
              <tbody>
                {schema.columns.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td className="mono muted-2">{c.type}</td>
                    <td>{c.nullable ? "YES" : "NO"}</td>
                    <td>
                      {c.key ? (
                        <StatusBadge
                          tone={c.key === "PRI" ? "accent" : "warn"}
                        >
                          {c.key}
                        </StatusBadge>
                      ) : (
                        <span className="muted-2">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="db-schema-block">
            <h4>CONSTRAINTS & INDEXES</h4>
            <div className="db-constraint">
              PRIMARY KEY
              <span className="mono">
                {(schema.primary_key ?? []).join(", ") || "—"}
              </span>
            </div>
            {schema.unique_keys.map((u) => (
              <div key={u.name} className="db-constraint">
                UNIQUE
                <span className="mono">
                  {u.name} ({u.columns.join(", ")})
                </span>
              </div>
            ))}
            {schema.foreign_keys.map((f) => (
              <button
                key={f.name}
                type="button"
                className="db-constraint link"
                onClick={() => onOpenTable?.(f.references_table)}
              >
                FOREIGN KEY
                <span className="mono">
                  {f.column} → {f.references_table}.{f.references_column}
                </span>
              </button>
            ))}
            {schema.indexes.map((i) => (
              <div key={i.name} className="db-constraint">
                INDEX
                <span className="mono">
                  {i.name} ({i.columns.join(", ")})
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loading ? (
        <LoadingState label="QUERYING MYSQL" />
      ) : error ? (
        <p className="error-text">{error}</p>
      ) : page && page.rows.length === 0 ? (
        <EmptyState title="NO ROWS" hint="No stored rows match this view." />
      ) : page ? (
        <div className="db-table-wrap">
          <table className="db-table">
            <thead>
              <tr>
                {page.columns.map((col) => (
                  <th
                    key={col}
                    className={numericColumns.has(col) ? "num" : undefined}
                    onClick={() => toggleSort(col)}
                    title="click to sort"
                  >
                    {col}
                    {sort.by === col ? (
                      <span className="sort-indicator">
                        {sort.dir === "asc" ? " ↑" : " ↓"}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, i) => (
                <tr key={row.id ?? i}>
                  {page.columns.map((col) => {
                    const value = row[col];
                    return (
                      <td
                        key={col}
                        className={[
                          numericColumns.has(col) ? "num mono" : "",
                          value == null ? "null-cell" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        title={value == null ? "NULL" : String(value)}
                      >
                        {value == null
                          ? "NULL"
                          : typeof value === "number" &&
                              !Number.isInteger(value)
                            ? value.toFixed(4).replace(/\.?0+$/, "")
                            : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {page && page.total > 0 ? (
        <div className="db-pagination">
          <span className="fineprint">
            Showing {formatInteger(rangeStart)}–{formatInteger(rangeEnd)} of{" "}
            {formatInteger(page.total)}
          </span>
          <div className="db-pagination-controls">
            <button
              type="button"
              className="btn small"
              disabled={offset <= 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              ← PREV
            </button>
            <span className="mono db-page-label">
              PAGE {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              className="btn small"
              disabled={rangeEnd >= page.total || loading}
              onClick={() => setOffset(offset + limit)}
            >
              NEXT →
            </button>
          </div>
        </div>
      ) : null}

      <p className="fineprint" style={{ marginTop: 10 }}>
        Read-only SELECT against MySQL via mysql-connector-python · max{" "}
        {500} rows per query.
      </p>
      {meta ? <p className="fineprint">{meta.label}</p> : null}
    </TerminalPanel>
  );
}

/* ------------------------------------------------------------------ */

function DatasetInspector({ onOpenTable }) {
  const { datasets } = useDatasets();
  const [selectedId, setSelectedId] = useState(datasets[0]?.id ?? null);
  const [storage, setStorage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setStorage(null);
    setError(null);
    getDatasetStorage(selectedId)
      .then((data) => !cancelled && setStorage(data))
      .catch((err) => !cancelled && setError(err.message || String(err)));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (datasets.length && !datasets.some((d) => d.id === selectedId)) {
      setSelectedId(datasets[0].id);
    }
  }, [datasets, selectedId]);

  const COUNT_LABELS = {
    datasets: "Dataset record",
    price_data: "Price observations",
    dataset_sources: "Source record",
    analysis_results: "Summary cache",
    fingerprints: "Fingerprint cache",
    analogue_matches: "Analogue cache",
    regime_models: "Regime models",
    regime_assignments: "Regime windows",
    intelligence_snapshots: "Intelligence cache",
  };

  return (
    <TerminalPanel
      title="DATASET INSPECTOR"
      subtitle="Raw data and every derived cache for one dataset"
    >
      <div className="db-inspector-head">
        <label className="control-inline">
          DATASET
          <select
            className="date-input"
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                #{d.id} — {d.filename}
              </option>
            ))}
          </select>
        </label>
        {storage?.source ? (
          <div className="db-source-chips">
            <StatusBadge tone="accent">
              {String(storage.source.provider).toUpperCase()}
            </StatusBadge>
            <StatusBadge tone="biscuit">{storage.source.symbol}</StatusBadge>
            <StatusBadge>
              {String(storage.source.price_interval).toUpperCase()}
            </StatusBadge>
          </div>
        ) : (
          <StatusBadge>CSV UPLOAD</StatusBadge>
        )}
      </div>

      {error ? (
        <p className="error-text">{error}</p>
      ) : !storage ? (
        <LoadingState label="READING MYSQL STORAGE" />
      ) : (
        <>
          <div className="db-storage-grid">
            {Object.entries(storage.counts).map(([table, count]) => (
              <button
                key={table}
                type="button"
                className={`db-storage-cell${count > 0 ? " populated" : ""}`}
                disabled={!count}
                title={count ? `Inspect ${table}` : "No rows"}
                onClick={() => onOpenTable(table, { dataset_id: storage.dataset_id })}
              >
                <span className="db-storage-count mono">
                  {formatInteger(count)}
                </span>
                <span className="db-storage-label">
                  {COUNT_LABELS[table] ?? table}
                </span>
                <span className="db-storage-table mono">{table}</span>
              </button>
            ))}
          </div>

          <div className="db-lineage-head">
            <h4 className="panel-kicker">DATA LINEAGE</h4>
          </div>
          <Lineage source={storage.source} />
        </>
      )}
    </TerminalPanel>
  );
}

/* ------------------------------------------------------------------ */

const QUERY_EXAMPLES = [
  {
    label: "LATEST PRICES",
    sql: "SELECT dataset_id, date, open, high, low, close, volume\nFROM price_data\nORDER BY date DESC\nLIMIT 25",
  },
  {
    label: "ROWS PER DATASET",
    sql: "SELECT d.id, d.filename, COUNT(*) AS rows_stored\nFROM datasets d\nJOIN price_data p ON p.dataset_id = d.id\nGROUP BY d.id, d.filename\nORDER BY d.id",
  },
  {
    label: "SHOW TABLES",
    sql: "SHOW TABLES",
  },
  {
    label: "TABLE SIZES",
    sql: "SELECT TABLE_NAME, TABLE_ROWS,\n  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024, 1) AS size_kb\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = DATABASE()\nORDER BY TABLE_NAME",
  },
];

function QueryConsole() {
  const { isDeveloper, isGuest } = useAuth();
  const [sql, setSql] = useState(
    "SELECT dataset_id, date, close, volume\nFROM price_data\nORDER BY date DESC\nLIMIT 25",
  );
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  const numericColumns = useMemo(() => {
    if (!result?.columns?.length || !result?.rows?.length) return new Set();
    const sets = result.columns.map((_, i) =>
      result.rows.every((row) => row[i] == null || typeof row[i] === "number"),
    );
    return new Set(result.columns.filter((_, i) => sets[i]));
  }, [result]);

  if (!isDeveloper) {
    return (
      <TerminalPanel
        title="SQL CONSOLE"
        subtitle="Run the exact queries you would run in MySQL Workbench"
      >
        <p className="fineprint">
          Raw SQL execution is restricted — <strong>DEVELOPER ACCESS
          REQUIRED</strong>. Guests can inspect every table through the bounded,
          read-only viewers above.
        </p>
      </TerminalPanel>
    );
  }

  const run = () => {
    setRunning(true);
    setError(null);
    setResult(null);
    runRawQuery(sql)
      .then(setResult)
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setRunning(false));
  };

  const onKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run();
    }
  };

  return (
    <TerminalPanel
      title="SQL CONSOLE"
      subtitle="Read-only · same statements and results as MySQL Workbench"
      actions={
        <>
          <button
            type="button"
            className="btn small accent"
            disabled={running}
            onClick={run}
          >
            {running ? "RUNNING…" : "RUN QUERY"}
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setSql("");
              setResult(null);
              setError(null);
            }}
          >
            CLEAR
          </button>
        </>
      }
    >
      <div className="db-query-examples">
        {QUERY_EXAMPLES.map((example) => (
          <button
            key={example.label}
            type="button"
            className={`chip-btn${sql === example.sql ? " active" : ""}`}
            onClick={() => setSql(example.sql)}
          >
            {example.label}
          </button>
        ))}
      </div>
      <textarea
        className="db-query-input mono"
        rows={6}
        spellCheck={false}
        value={sql}
        placeholder="SELECT … FROM … LIMIT 100"
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="fineprint">
        Ctrl+Enter to run · single statement · SELECT / SHOW / DESCRIBE /
        EXPLAIN only · server session is READ ONLY · max 500 rows.
      </p>

      {running ? <LoadingState label="EXECUTING QUERY" /> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {result && !running ? (
        <>
          <div className="db-query-meta">
            <span className="fineprint">
              {formatInteger(result.row_count)} row
              {result.row_count === 1 ? "" : "s"} ·{" "}
              {result.elapsed_ms != null ? `${result.elapsed_ms} ms` : "—"}
            </span>
            {result.truncated ? (
              <StatusBadge tone="warn">
                TRUNCATED AT {formatInteger(result.max_rows)}
              </StatusBadge>
            ) : null}
          </div>
          {result.row_count === 0 ? (
            <EmptyState title="EMPTY SET" hint="The query returned no rows." />
          ) : (
            <div className="db-table-wrap">
              <table className="db-table">
                <thead>
                  <tr>
                    {result.columns.map((col) => (
                      <th key={col} className={numericColumns.has(col) ? "num" : undefined}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((value, j) => (
                        <td
                          key={j}
                          className={[
                            numericColumns.has(result.columns[j]) ? "num mono" : "",
                            value == null ? "null-cell" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          title={value == null ? "NULL" : String(value)}
                        >
                          {value == null
                            ? "NULL"
                            : typeof value === "number" &&
                                !Number.isInteger(value)
                              ? value.toFixed(4).replace(/\.?0+$/, "")
                              : String(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </TerminalPanel>
  );
}

/* ------------------------------------------------------------------ */

function IntegrityPanel() {
  const { isDeveloper, isGuest } = useAuth();
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = () => {
    setRunning(true);
    setError(null);
    runIntegrityCheck()
      .then(setReport)
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setRunning(false));
  };

  const LABELS = {
    duplicate_dates: "Duplicate dates",
    orphan_observations: "Orphan observations",
    invalid_candles: "Invalid candles",
    dataset_rowcount_mismatches: "Dataset mismatches",
  };

  return (
    <TerminalPanel
      title="DATABASE INTEGRITY"
      subtitle="Read-only verification — never repairs or deletes data"
      actions={
        isDeveloper ? (
          <button
            type="button"
            className="btn small accent"
            disabled={running}
            onClick={run}
          >
            {running ? "CHECKING…" : "RUN INTEGRITY CHECK"}
          </button>
        ) : null
      }
    >
      {!report && !error ? (
        isGuest ? (
          <p className="fineprint">
            Integrity verification is a maintenance action —{" "}
            <strong>DEVELOPER ACCESS REQUIRED</strong>. All inspection above stays
            read-only and open.
          </p>
        ) : (
          <p className="fineprint">
            Manual check: verifies unique dataset/date protection, foreign-key
            integrity, OHLCV candle validity and registry row counts.
          </p>
        )
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      {report ? (
        <>
          <div className="metric-strip">
            {Object.entries(report.checks).map(([key, count]) => (
              <StatTile key={key} label={LABELS[key] ?? key} value={count} />
            ))}
          </div>
          <div className="ctx-item" style={{ border: "none", padding: 0 }}>
            <span className="ctx-label">STATUS</span>
            <StatusBadge tone={report.status === "HEALTHY" ? "up" : "down"}>
              {report.status}
            </StatusBadge>
          </div>
          {report.datasets_without_provenance.length > 0 ? (
            <p className="fineprint">
              {report.datasets_without_provenance.length} dataset(s) without
              import provenance (legitimate for CSV uploads).
            </p>
          ) : null}
        </>
      ) : null}
    </TerminalPanel>
  );
}

/* ------------------------------------------------------------------ */

export default function DatabasePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [tables, setTables] = useState(null);
  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const refresh = useCallback(() => {
    setLoadError(null);
    getDbStatus()
      .then(setStatus)
      .catch((err) => setStatus({ connected: false, reason: err.message }));
    getDbTables()
      .then(setTables)
      .catch((err) => setLoadError(err.message || String(err)));
    getDbStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const activeTable = searchParams.get("table");
  const datasetFilter = searchParams.get("dataset_id");
  // GET /database/tables answers { tables: [...] }; tolerate both shapes.
  const tableList = Array.isArray(tables) ? tables : (tables?.tables ?? []);
  const tableMeta = useMemo(
    () => tableList.find((t) => t.name === activeTable) ?? null,
    [tableList, activeTable],
  );

  const openTable = useCallback(
    (name, extra = {}) => {
      const next = { table: name };
      if (extra.dataset_id) next.dataset_id = String(extra.dataset_id);
      setSearchParams(next);
    },
    [setSearchParams],
  );

  const rawTables = tableList.filter((t) => t.category === "raw");
  const cacheTables = tableList.filter((t) => t.category === "cache");
  const configTables = tableList.filter((t) => t.category === "config");

  return (
    <div className="page">
      <SectionHeader
        title="Database"
        desc="Live inspector over the market_dna MySQL instance — read-only."
        right={
          <StatusBadge tone={status?.connected ? "up" : "down"}>
            {status == null
              ? "CHECKING…"
              : status.connected
                ? "MYSQL CONNECTED"
                : "MYSQL OFFLINE"}
          </StatusBadge>
        }
      />

      {status && !status.connected ? (
        <TerminalPanel title="MYSQL DATABASE">
          <div className="db-offline">
            <div className="metric-strip">
              <StatTile label="STATUS" value="OFFLINE" />
            </div>
            <p className="error-text">
              {status.reason ?? "Unable to establish database connection."}
            </p>
            <p className="fineprint">
              The rest of Finprix keeps working with cached analyses;
              database-backed views will resume automatically once MySQL is
              reachable again.
            </p>
          </div>
        </TerminalPanel>
      ) : (
        <>
          <div className="metric-strip" style={{ marginBottom: 14 }}>
            <StatTile label="STATUS" value={status?.connected ? "CONNECTED" : "…"} />
            <StatTile label="DATABASE" value={status?.database ?? "—"} />
            <StatTile label="TABLES" value={status?.tables_count ?? "—"} />
            <StatTile
              label="LATENCY"
              value={status?.latency_ms != null ? `${status.latency_ms} ms` : "—"}
            />
            <StatTile label="ENGINE" value="MySQL" />
            <StatTile label="CONNECTOR" value="mysql-connector-python" />
          </div>

          {stats ? (
            <div className="metric-strip" style={{ marginBottom: 14 }}>
              <StatTile label="DATASETS" value={formatInteger(stats.datasets)} />
              <StatTile
                label="MARKET IMPORTS"
                value={formatInteger(stats.market_imports)}
              />
              <StatTile
                label="CSV IMPORTS"
                value={formatInteger(stats.csv_imports)}
              />
              <StatTile
                label="PRICE OBSERVATIONS"
                value={formatInteger(stats.price_observations)}
              />
              <StatTile
                label="OLDEST OBS"
                value={stats.oldest_observation ? stats.oldest_observation : "—"}
              />
              <StatTile
                label="NEWEST OBS"
                value={stats.newest_observation ? stats.newest_observation : "—"}
              />
              <StatTile label="DATABASE SIZE" value={stats.size_pretty} />
            </div>
          ) : null}

          <div className="grid-side" style={{ alignItems: "start" }}>
            <TerminalPanel
              title="TABLES"
              subtitle="Raw / source data vs derived analysis caches"
              flush
            >
              {tables == null ? (
                <LoadingState label="READING TABLE REGISTRY" />
              ) : (
                <div className="db-table-list">
                  {[
                    ["RAW / SOURCE DATA", rawTables],
                    ["ANALYSIS / CACHE DATA", cacheTables],
                    ["CONFIGURATION", configTables],
                  ].map(([groupLabel, group]) =>
                    group.length ? (
                      <div key={groupLabel}>
                        <h4 className="panel-kicker">{groupLabel}</h4>
                        {group.map((t) => (
                          <button
                            key={t.name}
                            type="button"
                            className={`db-table-row${activeTable === t.name ? " active" : ""}`}
                            onClick={() => openTable(t.name)}
                          >
                            <span className="mono db-table-name">{t.name}</span>
                            <span className="db-table-desc">{t.label}</span>
                            <span className="mono db-table-count">
                              {formatInteger(t.rows)}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </TerminalPanel>

            <TerminalPanel
              title="RELATIONSHIPS"
              subtitle="Foreign keys radiating from datasets"
            >
              <div className="db-tree">
                <button
                  type="button"
                  className={`db-tree-node root${activeTable === "datasets" ? " active" : ""}`}
                  onClick={() => openTable("datasets")}
                >
                  <span className="mono">datasets</span>
                  <span className="fineprint">PK id</span>
                </button>
                <div className="db-tree-children">
                  {RELATIONSHIPS.map((node) => (
                    <button
                      key={node.table}
                      type="button"
                      className={`db-tree-node child depth-${node.depth}${activeTable === node.table ? " active" : ""}`}
                      onClick={() => openTable(node.table)}
                      style={{ marginLeft: (node.depth - 1) * 18 }}
                    >
                      <span className="tree-branch">└─</span>
                      <span className="mono">{node.label.split(" — ")[0]}</span>
                      <span className="fineprint">
                        {node.label.includes("—")
                          ? node.label.split(" — ")[1]
                          : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </TerminalPanel>
          </div>

          {activeTable ? (
            <TableViewer
              key={`${activeTable}-${datasetFilter ?? ""}`}
              name={activeTable}
              meta={tableMeta}
              initialFilters={
                datasetFilter && tableMeta?.category !== undefined &&
                (tableMeta.name === "price_data" ||
                  tableMeta.name === "datasets" ||
                  tableMeta.category === "cache")
                  ? { dataset_id: datasetFilter }
                  : {}
              }
              onOpenTable={openTable}
            />
          ) : null}

          <DatasetInspector onOpenTable={openTable} />

          <QueryConsole />

          <IntegrityPanel />

          <p className="disclaimer-text">
            This inspector issues bounded, parameterized SELECT statements
            through a server-side whitelist. Guests never submit raw SQL —
            they browse through the read-only viewers above. Developers get an
            additional SQL console whose session is READ ONLY server-side:
            mutating statements are rejected and data can only be looked at,
            never changed, from this page.
          </p>
        </>
      )}
    </div>
  );
}
