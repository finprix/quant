import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { uploadDataset, deleteDataset } from "../api/datasets.js";
import {
  searchMarket,
  startMarketImport,
  getImportStatus,
  updateMarketDataset,
  getMarketOverview,
} from "../api/market.js";
import { invalidateCache } from "../hooks/useApiData.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import { EmptyState } from "../components/states/States.jsx";
import { formatDate, formatInteger, formatPrice } from "../lib/format.js";

const STAGES = ["FETCHING", "VALIDATING", "WRITING TO MYSQL", "PREPARING DATASET"];

/* One-click catalog of widely followed Yahoo Finance instruments.
   SpaceX and other private companies are deliberately absent — they are
   not listed on any exchange, so no public market data exists for them. */
const MARKET_PICKS = [
  {
    group: "INDICES",
    assetType: "index",
    items: [
      ["^GSPC", "S&P 500"],
      ["^IXIC", "NASDAQ Composite"],
      ["^DJI", "Dow Jones Industrial"],
      ["^RUT", "Russell 2000"],
      ["^VIX", "Volatility Index (VIX)"],
      ["^NSEI", "NIFTY 50"],
    ],
  },
  {
    group: "STOCKS",
    assetType: "stock",
    items: [
      ["AAPL", "Apple"],
      ["MSFT", "Microsoft"],
      ["NVDA", "NVIDIA"],
      ["GOOGL", "Alphabet"],
      ["AMZN", "Amazon"],
      ["META", "Meta Platforms"],
      ["TSLA", "Tesla"],
      ["JPM", "JPMorgan Chase"],
    ],
  },
  {
    group: "CRYPTO",
    assetType: "cryptocurrency",
    items: [
      ["BTC-USD", "Bitcoin"],
      ["ETH-USD", "Ethereum"],
    ],
  },
  {
    group: "COMMODITIES & FX",
    assetType: "futures",
    items: [
      ["GC=F", "Gold Futures"],
      ["CL=F", "WTI Crude Oil"],
      ["EURUSD=X", "Euro / US Dollar"],
    ],
  },
];

function relativeTime(iso) {
  if (!iso) return "—";
  const then = new Date(String(iso).includes("T") ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(then)) return formatDate(iso);
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/* ------------------------------------------------------------------ */
/* Ingestion pipeline visualization (§11)                              */
/* ------------------------------------------------------------------ */

function ImportPipeline({ providerLabel, job, selected }) {
  const stageIndex = STAGES.indexOf(job.stage);
  const done = job.stage === "COMPLETE";
  const failed = job.stage === "FAILED";
  const details = job.details ?? {};
  const receipt = job.result?.receipt;

  const steps = [
    {
      label: String(providerLabel || selected?.exchange || "PROVIDER").toUpperCase(),
      body: null,
      reached: true,
    },
    {
      label: "FETCH",
      body:
        job.observations != null
          ? `${formatInteger(job.observations)} observations received`
          : failed
            ? "failed"
            : "requesting historical observations…",
      reached: job.observations != null || stageIndex > 0 || done,
    },
    {
      label: "NORMALIZE",
      body:
        details.valid != null
          ? `${formatInteger(details.valid)} valid OHLCV · ${formatInteger(details.rejected)} rejected`
          : failed
            ? "not reached"
            : "validating…",
      reached: details.valid != null || stageIndex >= 2 || done,
    },
    {
      label: "MYSQL",
      body:
        receipt?.mysql
          ? `dataset record ✓ · source metadata ✓ · ${formatInteger(receipt.mysql.price_observations)} price rows`
          : failed
            ? "not reached"
            : "writing…",
      reached: stageIndex >= 3 || done,
    },
    {
      label: "QUANT VECTOR",
      body: receipt?.analysis
        ? Object.entries(receipt.analysis)
            .map(([engine, state]) => `${engine}: ${state}`)
            .join(" · ")
        : done
          ? "preparing dataset…"
          : "pending",
      reached: done,
    },
  ];

  return (
    <div className={`import-pipeline${failed ? " failed" : ""}`}>
      {steps.map((step) => (
        <div key={step.label} className="pipeline-step">
          <span className={`pipeline-node${step.reached ? " reached" : ""}`}>
            {step.label}
          </span>
          {step.body ? (
            <span className="fineprint">{step.body}</span>
          ) : (
            <span className="db-lineage-arrow">▼</span>
          )}
        </div>
      ))}
      <div className="pipeline-step">
        <span className={`pipeline-node${done ? " reached final" : ""}`}>
          {failed ? "FAILED" : done ? "COMPLETE" : "…"}
        </span>
        {job.error ? (
          <p className="error-text">MARKET DATA UNAVAILABLE — {job.error}</p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Import receipt (§12)                                                */
/* ------------------------------------------------------------------ */

function ImportReceipt({ result }) {
  const r = result.receipt;
  if (!r) return null;
  return (
    <div className="receipt">
      <h4 className="panel-kicker">
        IMPORT COMPLETE — {r.symbol}
        {r.instrument_name ? ` · ${r.instrument_name}` : ""}
      </h4>
      <div className="metric-strip">
        {[
          ["RECEIVED", formatInteger(r.received)],
          ["VALID", formatInteger(r.valid)],
          ["REJECTED", formatInteger(r.rejected)],
          ["INSERTED", formatInteger(r.inserted)],
          ["INTERVAL", String(r.interval).toUpperCase()],
          ["DATASET", `#${result.dataset_id}`],
        ].map(([label, value]) => (
          <div className="metric-tile" key={label}>
            <span className="metric-label">{label}</span>
            <span className="metric-value" style={{ fontSize: 13 }}>
              {value}
            </span>
          </div>
        ))}
      </div>
      <div className="db-constraint">
        MYSQL<span className="mono">
          datasets ✓ · dataset_sources ✓ · price_data ({formatInteger(r.mysql.price_observations)})
        </span>
      </div>
      <div className="db-constraint">
        ANALYSIS<span className="mono">
          {Object.entries(r.analysis)
            .map(([engine, state]) => `${engine}: ${state}`)
            .join(" · ")}
        </span>
      </div>
      <div className="row-actions" style={{ marginTop: 10 }}>
        <Link className="btn small accent" to="/">
          OPEN OVERVIEW
        </Link>
        <Link className="btn small" to={`/database?table=price_data&dataset_id=${result.dataset_id}`}>
          VIEW MYSQL ROWS
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Update receipt (§13)                                                */
/* ------------------------------------------------------------------ */

function UpdateReceipt({ receipt, onClose }) {
  if (!receipt) return null;
  return (
    <TerminalPanel
      title={`UPDATE COMPLETE — ${receipt.symbol}`}
      actions={
        <button type="button" className="btn small" onClick={onClose}>
          DISMISS
        </button>
      }
    >
      <div className="metric-strip" style={{ marginBottom: 8 }}>
        {[
          ["REQUEST RANGE", `${receipt.request_range.start} → ${receipt.request_range.end}`],
          ["FETCHED", formatInteger(receipt.fetched)],
          ["INSERTED", formatInteger(receipt.inserted)],
          ["REPLACED", formatInteger(receipt.replaced)],
          ["UNCHANGED", formatInteger(receipt.unchanged)],
          ["LAST STORED", receipt.last_stored_date],
        ].map(([label, value]) => (
          <div className="metric-tile" key={label}>
            <span className="metric-label">{label}</span>
            <span className="metric-value" style={{ fontSize: 12 }}>
              {value}
            </span>
          </div>
        ))}
      </div>
      <div className="db-constraint">
        CACHE
        <span className="mono">
          {(receipt.caches_invalidated ?? []).join(" · ")} INVALIDATED
        </span>
      </div>
      <Link
        className="btn small accent"
        style={{ marginTop: 8, display: "inline-block" }}
        to={`/database?table=price_data&dataset_id=${
          receipt.dataset_id ?? ""
        }`}
      >
        VIEW UPDATED ROWS
      </Link>
    </TerminalPanel>
  );
}

/* ------------------------------------------------------------------ */

export default function Datasets() {
  const {
    datasets,
    datasetsLoading,
    datasetsError,
    refreshDatasets,
    activeId,
    selectDataset,
  } = useDatasets();

  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [mode, setMode] = useState(null); // null | 'csv' | 'market'
  const { isDeveloper, isGuest } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [noticeError, setNoticeError] = useState(null);
  const [noticeOk, setNoticeOk] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [sources, setSources] = useState({});
  const [updateReceiptData, setUpdateReceiptData] = useState(null);

  // Market import state
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(null);
  const [fromDate, setFromDate] = useState("2020-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [job, setJob] = useState(null); // {jobId,stage,status,observations,details,result,error,terminal}

  useEffect(() => {
    let cancelled = false;
    getMarketOverview()
      .then((payload) => {
        if (cancelled) return;
        const map = {};
        for (const row of payload.instruments ?? []) {
          if (row.source) map[row.dataset_id] = row.source;
        }
        setSources(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [datasets.length]);

  useEffect(() => {
    if (!job?.jobId || job?.terminal) return undefined;
    const timer = setInterval(async () => {
      try {
        const status = await getImportStatus(job.jobId);
        setJob((prev) => ({
          ...prev,
          stage: status.stage,
          observations: status.observations,
          details: status.details ?? prev.details,
          error: status.error,
          result: status.result,
          terminal: ["COMPLETE", "FAILED"].includes(status.status),
        }));
      } catch {
        /* transient polling errors are non-fatal */
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [job]);

  const onPickFile = () => fileInputRef.current?.click();

  const onFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setNoticeError(null);
    setNoticeOk(null);
    setUploading(true);
    try {
      const result = await uploadDataset(file);
      await refreshDatasets();
      invalidateCache();
      const ds = result?.dataset;
      if (ds?.id) selectDataset(ds.id);
      setNoticeOk(
        `Uploaded ${ds?.filename ?? file.name} — ${ds?.rows ?? "?"} rows accepted.`,
      );
    } catch (error) {
      setNoticeError(error?.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (id) => {
    setDeletingId(id);
    try {
      await deleteDataset(id);
      await refreshDatasets();
      invalidateCache();
    } catch (error) {
      setNoticeError(`Delete failed: ${error?.message || id}`);
    } finally {
      setDeletingId(null);
    }
  };

  const onUpdate = async (id, sourceSymbol) => {
    setUpdatingId(id);
    setNoticeError(null);
    try {
      const result = await updateMarketDataset(id);
      await refreshDatasets();
      invalidateCache();
      setUpdateReceiptData({
        ...result.receipt,
        symbol: result.receipt?.symbol ?? sourceSymbol,
        dataset_id: id,
      });
    } catch (error) {
      setNoticeError(`Update failed: ${error?.message || id}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const runSearch = async () => {
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    setNoticeError(null);
    setSelected(null);
    try {
      const payload = await searchMarket(text);
      setResults(payload.results ?? []);
    } catch (error) {
      setResults([]);
      setNoticeError(error?.message || "Search failed.");
    } finally {
      setSearching(false);
    }
  };

  const startImport = async () => {
    if (!selected) return;
    setNoticeError(null);
    try {
      const response = await startMarketImport({
        symbol: selected.symbol,
        start_date: fromDate,
        end_date: toDate,
        interval: "1d",
        provider: "yahoo",
        name: selected.name,
        exchange: selected.exchange,
        asset_type: selected.asset_type,
        currency: selected.currency,
      });
      setJob({
        jobId: response.job_id,
        stage: "FETCHING",
        terminal: false,
        observations: null,
        details: null,
        result: null,
        error: null,
      });
    } catch (error) {
      setNoticeError(error?.message || "Import could not be started.");
    }
  };

  const finishImportLocally = async (datasetId) => {
    await refreshDatasets();
    invalidateCache();
    selectDataset(datasetId);
  };

  useEffect(() => {
    if (!job?.terminal || job.stage !== "COMPLETE" || !job.result?.dataset_id) return;
    finishImportLocally(job.result.dataset_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.terminal, job?.stage]);

  const viewMysqlRows = (id) => `/database?table=price_data&dataset_id=${id}`;

  return (
    <div className="page">
      <SectionHeader
        title="Market Library"
        desc="Upload CSVs or fetch real market data into MySQL. Both paths feed the same Quant Vector engine."
        right={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={onFileSelected}
            />
            {isDeveloper ? (
              <>
                <button type="button" className="btn" onClick={onPickFile} disabled={uploading}>
                  {uploading ? "Uploading…" : "UPLOAD CSV"}
                </button>
                <button
                  type="button"
                  className="btn accent"
                  onClick={() => setMode(mode === "market" ? null : "market")}
                >
                  FETCH MARKET DATA
                </button>
              </>
            ) : (
              <StatusBadge tone="accent">RESEARCH MODE — READ ONLY</StatusBadge>
            )}
          </>
        }
      />

      {isGuest ? (
        <div className="panel locked-note">
          <div className="panel-body">
            <span className="lock-icon" aria-hidden="true">🔒</span>
            DEVELOPER ACCESS REQUIRED for data changes. Dataset modification is
            restricted to developer sessions — browsing, analysis and exports stay open.
          </div>
        </div>
      ) : null}

      {updateReceiptData ? (
        <UpdateReceipt
          receipt={updateReceiptData}
          onClose={() => setUpdateReceiptData(null)}
        />
      ) : null}

      {noticeOk ? (
        <div className="panel">
          <div className="panel-body" style={{ padding: "9px 14px", color: "var(--up)" }}>
            {noticeOk}
          </div>
        </div>
      ) : null}
      {noticeError ? (
        <div className="panel">
          <div className="panel-body notice-error">{noticeError}</div>
        </div>
      ) : null}
      {datasetsError ? (
        <div className="panel">
          <div className="panel-body notice-error">{datasetsError}</div>
        </div>
      ) : null}

      {/* ------------------------------------------------ MARKET IMPORT */}
      {mode === "market" ? (
        isDeveloper ? (
        <TerminalPanel title="FETCH MARKET DATA — YAHOO FINANCE">
          <form
            className="ai-query-form"
            onSubmit={(event) => {
              event.preventDefault();
              runSearch();
            }}
          >
            <input
              className="ai-input"
              value={query}
              placeholder="Search symbol, company, index… (e.g. NIFTY 50, Apple, Gold, Bitcoin)"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="btn accent" disabled={searching || !query.trim()}>
              {searching ? "SEARCHING…" : "SEARCH"}
            </button>
          </form>

          <div className="market-picks">
            {MARKET_PICKS.map(({ group, assetType, items }) => (
              <div className="market-pick-group" key={group}>
                <h4 className="panel-kicker">{group}</h4>
                <div className="market-pick-row">
                  {items.map(([symbol, label]) => (
                    <button
                      key={symbol}
                      type="button"
                      title={`${label} (${symbol})`}
                      className={`market-pick mono${selected?.symbol === symbol ? " selected" : ""}`}
                      onClick={() =>
                        setSelected({
                          symbol,
                          name: label,
                          asset_type: assetType,
                        })
                      }
                    >
                      {symbol}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="fineprint">
              Private companies (SpaceX, Stripe…) are not listed on any exchange —
              no public market data exists for them. Everything above imports with
              one click; anything else Yahoo Finance knows can be found via search.
            </p>
          </div>

          {results ? (
            results.length === 0 ? (
              <p className="fineprint" style={{ marginTop: 10 }}>
                No instruments matched. Try a different name or symbol.
              </p>
            ) : (
              <div className="market-results">
                {results.map((item) => (
                  <button
                    key={item.symbol}
                    type="button"
                    className={`market-result${selected?.symbol === item.symbol ? " selected" : ""}`}
                    onClick={() => setSelected(item)}
                  >
                    <span className="mono market-symbol">{item.symbol}</span>
                    <span className="market-name">{item.name ?? "—"}</span>
                    <span className="market-meta mono">
                      {[item.exchange, item.asset_type].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : null}

          {selected ? (
            <div className="market-detail">
              <h3 className="market-detail-title">
                {(selected.name ?? selected.symbol).toUpperCase()}
              </h3>
              <div className="metric-strip">
                {[
                  { label: "SYMBOL", value: selected.symbol },
                  { label: "EXCHANGE", value: selected.exchange ?? "—" },
                  { label: "ASSET TYPE", value: selected.asset_type ?? "—" },
                  { label: "CURRENCY", value: selected.currency ?? "—" },
                ].map((tile) => (
                  <div className="metric-tile" key={tile.label}>
                    <span className="metric-label">{tile.label}</span>
                    <span className="metric-value">{tile.value}</span>
                  </div>
                ))}
              </div>
              <div className="market-range-row">
                <label className="control-inline">
                  INTERVAL
                  <select defaultValue="1d" disabled>
                    <option value="1d">1D</option>
                  </select>
                </label>
                <label className="control-inline">
                  FROM
                  <input
                    type="date"
                    className="date-input"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                  />
                </label>
                <label className="control-inline">
                  TO
                  <input
                    type="date"
                    className="date-input"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn accent"
                  disabled={Boolean(job && !job.terminal)}
                  onClick={startImport}
                >
                  IMPORT INTO QUANT VECTOR
                </button>
              </div>
            </div>
          ) : null}

          {job ? (
            <>
              <div className={`import-progress${job.stage === "FAILED" ? " failed" : ""}`}>
                <div className="import-head">
                  <StatusBadge
                    tone={job.stage === "FAILED" ? "down" : job.stage === "COMPLETE" ? "up" : "warn"}
                  >
                    {`IMPORTING ${selected?.symbol ?? ""} — ${job.stage}`}
                  </StatusBadge>
                </div>
                <ImportPipeline
                  providerLabel={selected ? `YAHOO FINANCE · ${selected.exchange ?? ""}` : ""}
                  job={job}
                  selected={selected}
                />
              </div>

              {job.stage === "COMPLETE" &&
                (job.result?.status === "complete" ? (
                  <div style={{ marginTop: 12 }}>
                    <ImportReceipt result={job.result} />
                  </div>
                ) : (
                  <div style={{ marginTop: 12 }}>
                    <p className="fineprint">{job.result?.message}</p>
                    <Link className="btn small" to="/">
                      OPEN DATASET
                    </Link>
                  </div>
                ))}
            </>
          ) : null}

          <p className="fineprint" style={{ marginTop: 12 }}>
            Data source: Yahoo Finance (historical end-of-day). Re-importing an
            already-stored symbol extends it incrementally instead of duplicating.
          </p>
        </TerminalPanel>
        ) : (
          <div className="panel locked-note">
            <div className="panel-body">
              <span className="lock-icon" aria-hidden="true">🔒</span>
              DEVELOPER ACCESS REQUIRED — dataset modification is restricted to
              developer sessions.
            </div>
          </div>
        )
      ) : null}

      {/* ------------------------------------------------ LIBRARY TABLE */}
      <TerminalPanel
        title={`MARKET LIBRARY${datasets.length ? ` · ${datasets.length}` : ""}`}
        flush
        actions={
          <button
            type="button"
            className="btn small"
            onClick={() => {
              refreshDatasets();
              invalidateCache();
            }}
          >
            REFRESH
          </button>
        }
      >
        {datasetsLoading ? (
          <EmptyState title="LOADING REGISTRY" />
        ) : datasets.length === 0 ? (
          <EmptyState
            title="NO DATASETS"
            hint="Fetch market data or upload a CSV (Date,Open,High,Low,Close,Volume) to begin."
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="dna-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Interval</th>
                  <th>Start → End</th>
                  <th style={{ textAlign: "right" }}>Rows</th>
                  <th style={{ textAlign: "right" }}>Last Close</th>
                  <th>Last Updated</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {datasets.map((d) => {
                  const source = sources[d.id];
                  return (
                    <tr
                      key={d.id}
                      className={`clickable${d.id === activeId ? " selected" : ""}`}
                      onClick={() => selectDataset(d.id)}
                      title={
                        source
                          ? `Last data ${formatDate(d.end_date)} · updated ${relativeTime(
                              source.last_updated,
                            )}`
                          : `CSV dataset #${d.id}`
                      }
                    >
                      <td className="mono">{source ? source.symbol : `#${d.id}`}</td>
                      <td className="text-cell">
                        {source?.instrument_name ?? source?.symbol ?? d.filename}
                      </td>
                      <td>
                        <StatusBadge tone={source ? "accent" : ""}>
                          {source ? String(source.provider).toUpperCase() : "CSV"}
                        </StatusBadge>
                      </td>
                      <td className="mono">
                        {source ? String(source.price_interval).toUpperCase() : "—"}
                      </td>
                      <td className="mono">
                        {formatDate(d.start_date)} → {formatDate(d.end_date)}
                      </td>
                      <td style={{ textAlign: "right" }}>{formatInteger(d.row_count)}</td>
                      <td style={{ textAlign: "right" }} className="num-pos">
                        {formatPrice(d.latest_close)}
                      </td>
                      <td>{source ? relativeTime(source.last_updated) : "—"}</td>
                      <td>
                        {d.id === activeId ? (
                          <StatusBadge tone="accent">ACTIVE</StatusBadge>
                        ) : (
                          <StatusBadge>READY</StatusBadge>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          {isDeveloper && source ? (
                            <button
                              type="button"
                              className="btn small"
                              disabled={updatingId === d.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                onUpdate(d.id, sources[d.id]?.symbol);
                              }}
                            >
                              {updatingId === d.id ? "…" : "Update"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn small"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(viewMysqlRows(d.id));
                            }}
                            title="Inspect the actual MySQL rows for this dataset"
                          >
                            View MySQL Data
                          </button>
                          {isDeveloper ? (
                            <button
                              type="button"
                              className="btn small danger"
                              disabled={deletingId === d.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                onDelete(d.id);
                              }}
                            >
                              {deletingId === d.id ? "…" : "Delete"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </TerminalPanel>

      <p className="disclaimer-text">
        Imported instruments use historical end-of-day data from Yahoo Finance and
        are never labelled live or real-time. Rows are validated server-side:
        malformed candles are dropped rather than fabricated, duplicates are
        prevented at the database level, and every data change invalidates cached
        analyses so all views recompute from MySQL.
      </p>
    </div>
  );
}
