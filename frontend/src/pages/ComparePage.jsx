import { useEffect, useMemo, useState } from "react";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { compareFingerprints } from "../api/compare.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  NoDatasetState,
} from "../components/states/States.jsx";
import CompareWorkspace from "../components/compare/CompareWorkspace.jsx";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  DnaChart,
  AXIS_STYLE,
  TooltipBox,
  CHART_COLORS,
} from "../components/charts/primitives.jsx";
import { buildDerivedFrame, percentileRank } from "../lib/marketMath.js";
import {
  formatSignedPercent,
  formatPercent,
  formatNumber,
} from "../lib/format.js";

const MODES = [
  { key: "dual", label: "DATASET A/B" },
  { key: "periods", label: "PERIOD A/B" },
  { key: "workspace", label: "WORKSPACE" },
];

const PERIOD_LENGTHS = [30, 60, 90, 120];

export default function ComparePage() {
  const [mode, setMode] = useState("dual");
  return (
    <div className="page">
      <SectionHeader
        title="Compare Engine"
        desc="Two-sided quantitative comparison across datasets or historical periods."
        right={
          <div className="chip-row">
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={mode === m.key}
                className={`chip-btn${mode === m.key ? " active" : ""}`}
                onClick={() => setMode(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      />
      {mode === "dual" ? <DualCompare /> : null}
      {mode === "periods" ? <PeriodCompare /> : null}
      {mode === "workspace" ? <CompareWorkspace /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared two-sided metric bar                                         */
/* ------------------------------------------------------------------ */

function TwoSidedRow({ label, valueA, valueB, textA, textB }) {
  const a = Number.isFinite(valueA) ? Math.abs(valueA) : 0;
  const b = Number.isFinite(valueB) ? Math.abs(valueB) : 0;
  const total = a + b;
  const fracA = total > 0 ? a / total : 0.5;
  return (
    <div style={{ padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 1fr", gap: 12, alignItems: "center" }}>
        <div style={{ textAlign: "right" }}>
          <span className="mono" style={{ fontSize: 13 }}>{textA}</span>
          <div style={{ height: 5, background: "var(--bg-0)", border: "1px solid var(--border)", borderRadius: 2, marginTop: 4, marginLeft: 40 }}>
            <div style={{ height: "100%", width: `${fracA * 100}%`, marginLeft: `${(1 - fracA) * 100}%`, background: "var(--biscuit)" }} />
          </div>
        </div>
        <span className="metric-label" style={{ textAlign: "center" }}>{label}</span>
        <div>
          <span className="mono" style={{ fontSize: 13 }}>{textB}</span>
          <div style={{ height: 5, background: "var(--bg-0)", border: "1px solid var(--border)", borderRadius: 2, marginTop: 4, marginRight: 40 }}>
            <div style={{ height: "100%", width: `${(1 - fracA) * 100}%`, background: "linear-gradient(90deg, var(--burgundy-700), var(--burgundy-accent))" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function diffRows(defs, valA, valB) {
  return defs
    .map((d) => {
      const a = valA(d);
      const b = valB(d);
      return {
        label: d.label,
        fmt: d.fmt,
        a,
        b,
        abs: Number.isFinite(a) && Number.isFinite(b) ? b - a : null,
      };
    })
    .filter((r) => r.a != null && r.b != null);
}

/* ------------------------------------------------------------------ */
/* DATASET A / B mode                                                  */
/* ------------------------------------------------------------------ */

const DATASET_DEFS = [
  { key: "total_return", label: "TOTAL RETURN", fmt: (v) => formatSignedPercent(v), get: (c) => c.metrics?.total_return },
  { key: "vol", label: "VOLATILITY (ANN.)", fmt: (v) => formatPercent(v), get: (c) => c.metrics?.annualized_volatility },
  { key: "maxdd", label: "MAX DRAWDOWN", fmt: (v) => formatSignedPercent(v), get: (c) => c.metrics?.max_drawdown },
  { key: "mom60", label: "MOMENTUM 60D", fmt: (v) => formatSignedPercent(v), get: (c) => c.fingerprint?.momentum_60 },
  { key: "trend", label: "TREND STRENGTH (MA50 GAP)", fmt: (v) => formatSignedPercent(v), get: (c) => c.fingerprint?.distance_from_ma50 },
  { key: "riskadj", label: "SHARPE-LIKE (RET / |MAXDD|)", fmt: (v) => formatNumber(v, 2), get: (c) => {
      const r = c.metrics?.total_return;
      const dd = c.metrics?.max_drawdown;
      return Number.isFinite(r) && Number.isFinite(dd) && dd !== 0 ? r / Math.abs(dd) : null;
    } },
  { key: "volume", label: "AVG VOLUME", fmt: (v) => formatNumber(v, 0), get: (c) => c.metrics?.average_volume },
];

function DualCompare() {
  const { datasets, activeId } = useDatasets();
  const [idA, setIdA] = useState(activeId ?? datasets[0]?.id ?? null);
  const [idB, setIdB] = useState(datasets.find((d) => d.id !== (activeId ?? datasets[0]?.id))?.id ?? null);

  const pathA = idA ? `/datasets/${idA}` : null;
  const pathB = idB ? `/datasets/${idB}` : null;
  const fpAPath = idA ? `/datasets/${idA}/fingerprint` : null;
  const fpBPath = idB ? `/datasets/${idB}/fingerprint` : null;
  const prA = idA ? `/datasets/${idA}/prices` : null;
  const prB = idB ? `/datasets/${idB}/prices` : null;

  const qA = useApiData(pathA);
  const qB = useApiData(pathB);
  const fA = useApiData(fpAPath);
  const fB = useApiData(fpBPath);
  const pA = useApiData(prA);
  const pB = useApiData(prB);

  const idsKey = idA && idB ? `${idA},${idB}` : null;
  const [similarity, setSimilarity] = useState(null);
  const [simError, setSimError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setSimilarity(null);
    setSimError(null);
    if (!idsKey) return undefined;
    compareFingerprints([Number(idA), Number(idB)])
      .then((payload) => {
        if (!cancelled) {
          const pair = payload?.pairs?.[0];
          setSimilarity(pair?.similarity_score ?? pair?.overall_similarity ?? null);
        }
      })
      .catch((err) => {
        if (!cancelled) setSimError(err?.message || "Fingerprint comparison failed.");
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxA = useMemo(
    () => ({ metrics: qA.data?.metrics, fingerprint: fA.data?.fingerprint }),
    [qA.data, fA.data],
  );
  const ctxB = useMemo(
    () => ({ metrics: qB.data?.metrics, fingerprint: fB.data?.fingerprint }),
    [qB.data, fB.data],
  );

  const overlay = useMemo(() => {
    const rowsA = pA.data?.prices;
    const rowsB = pB.data?.prices;
    if (!rowsA?.length || !rowsB?.length) return [];
    const mapB = new Map(rowsB.map((r) => [String(r.date).slice(0, 10), Number(r.close)]));
    const shared = rowsA
      .map((r) => [String(r.date).slice(0, 10), Number(r.close)])
      .filter(([d]) => mapB.has(d));
    if (shared.length < 2) return [];
    const baseA = shared[0][1];
    const baseB = mapB.get(shared[0][0]);
    return shared.map(([date, ca], i) => ({
      date,
      a: baseA > 0 ? (ca / baseA) * 100 : null,
      b: baseB > 0 ? (mapB.get(date) / baseB) * 100 : null,
      idx: i,
    }));
  }, [pA.data, pB.data]);

  if (!datasets.length) return <NoDatasetState />;

  const loading =
    (qA.loading && !qA.data) || (qB.loading && !qB.data);

  const nameOf = (id) => {
    const d = datasets.find((x) => x.id === id);
    return d ? `#${d.id} ${d.filename}` : "—";
  };

  const diffs = diffRows(
    DATASET_DEFS,
    (d) => d.get(ctxA),
    (d) => d.get(ctxB),
  );

  return (
    <>
      <TerminalPanel title="Sides">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div className="control" style={{ minWidth: 260 }}>
            <label>SIDE A · BISCUIT</label>
            <select value={idA ?? ""} onChange={(e) => setIdA(Number(e.target.value))}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{nameOf(d.id)}</option>
              ))}
            </select>
          </div>
          <div className="control" style={{ minWidth: 260 }}>
            <label>SIDE B · BURGUNDY</label>
            <select value={idB ?? ""} onChange={(e) => setIdB(Number(e.target.value))}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{nameOf(d.id)}</option>
              ))}
            </select>
          </div>
          <div style={{ marginLeft: "auto", alignSelf: "center" }}>
            <StatusBadge tone="neutral">SIMILARITY</StatusBadge>{" "}
            <span className="metric-value biscuit">
              {similarity != null ? formatPercent(similarity) : simError ? "N/A" : "…"}
            </span>
          </div>
        </div>
      </TerminalPanel>

      {loading ? (
        <LoadingState label="FETCHING BOTH SIDES" />
      ) : !ctxA.metrics || !ctxB.metrics ? (
        <ErrorState
          message={(qA.error || qB.error)?.message || "Dataset details unavailable."}
          status={(qA.error || qB.error)?.status}
          onRetry={() => {
            qA.refetch();
            qB.refetch();
          }}
        />
      ) : (
        <>
          <div className="grid-2">
            <TerminalPanel title="Head-to-Head Metrics" subtitle={`A = ${nameOf(idA)} · B = ${nameOf(idB)}`}>
              {DATASET_DEFS.map((def) => (
                <TwoSidedRow
                  key={def.key}
                  label={def.label}
                  valueA={def.get(ctxA)}
                  valueB={def.get(ctxB)}
                  textA={def.get(ctxA) != null ? def.fmt(def.get(ctxA)) : "N/A"}
                  textB={def.get(ctxB) != null ? def.fmt(def.get(ctxB)) : "N/A"}
                />
              ))}
            </TerminalPanel>

            <TerminalPanel title="Statistical Difference" subtitle="B relative to A; sign conventions follow each metric">
              <table className="dna-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th style={{ textAlign: "right" }}>Δ absolute</th>
                    <th style={{ textAlign: "right" }}>A</th>
                    <th style={{ textAlign: "right" }}>B</th>
                  </tr>
                </thead>
                <tbody>
                  {diffs.map((row) => (
                    <tr key={row.label}>
                      <td className="text-cell" style={{ color: "var(--muted)" }}>{row.label}</td>
                      <td style={{ textAlign: "right" }} className={row.abs >= 0 ? "num-pos" : "num-neg"}>
                        {row.abs != null ? row.fmt(row.abs) : "N/A"}
                      </td>
                      <td style={{ textAlign: "right" }}>{row.fmt(row.a)}</td>
                      <td style={{ textAlign: "right" }}>{row.fmt(row.b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {similarity != null ? (
                <p className="disclaimer-text" style={{ marginTop: 8 }}>
                  Whole-history fingerprint similarity for this pair:{" "}
                  {formatPercent(similarity)} (1.0 = statistically identical profiles).
                </p>
              ) : null}
            </TerminalPanel>
          </div>

          <TerminalPanel
            title="Rebased Overlay"
            subtitle="Both sides normalized to 100 on the first shared trading date"
          >
            {overlay.length > 1 ? (
              <DnaChart height={300}>
                <LineChart data={overlay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 5" vertical={false} />
                  <XAxis dataKey="date" tick={AXIS_STYLE} tickLine={false} minTickGap={70} />
                  <YAxis tick={AXIS_STYLE} tickLine={false} width={52} domain={["auto", "auto"]} />
                  <Tooltip content={<TooltipBox formatter={(e) => `${e.name}: ${Number(e.value).toFixed(2)}`} />} />
                  <Line type="monotone" dataKey="a" name={`A · ${nameOf(idA)}`} stroke={CHART_COLORS.biscuit} strokeWidth={1.4} dot={false} animationDuration={380} />
                  <Line type="monotone" dataKey="b" name={`B · ${nameOf(idB)}`} stroke={CHART_COLORS.primary} strokeWidth={1.6} dot={false} animationDuration={380} />
                </LineChart>
              </DnaChart>
            ) : (
              <EmptyState
                title="NO SHARED DATES"
                hint="These datasets do not overlap on any trading dates, so a synchronized overlay is impossible."
              />
            )}
          </TerminalPanel>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* PERIOD A / B mode                                                   */
/* ------------------------------------------------------------------ */

function sliceStats(frame, startIdx, endIdx) {
  const closes = frame.closes.slice(startIdx, endIdx + 1);
  if (closes.length < 5) return null;
  const ret = closes[closes.length - 1] / closes[0] - 1;
  // annualized vol from within-slice daily returns
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, v) => a + v, 0) / rets.length;
  const variance = rets.reduce((a, v) => a + (v - mean) ** 2, 0) / (rets.length - 1);
  const volAnn = Math.sqrt(variance) * Math.sqrt(252);
  let peak = -Infinity;
  let maxDD = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    maxDD = Math.min(maxDD, c / peak - 1);
  }
  // trend strength: final close vs slice MA20 (genuine derivation)
  const window = closes.slice(-Math.min(20, closes.length));
  const ma = window.reduce((a, v) => a + v, 0) / window.length;
  return {
    ret,
    volAnn,
    maxDD,
    trend: ma > 0 ? closes[closes.length - 1] / ma - 1 : null,
    days: closes.length,
  };
}

function PeriodCompare() {
  const { activeId, activeDataset } = useDatasets();
  const [length, setLength] = useState(60);
  const pricesQuery = useApiData(activeId ? `/datasets/${activeId}/prices` : null);

  const frame = useMemo(() => {
    const rows = pricesQuery.data?.prices;
    if (!rows || rows.length < 20) return null;
    return buildDerivedFrame(rows);
  }, [pricesQuery.data]);

  const stats = useMemo(() => {
    if (!frame) return null;
    const n = frame.dates.length;
    const endA = n - 1;
    const startA = Math.max(0, endA - length + 1);
    const endB = startA - 1;
    const startB = Math.max(0, endB - length + 1);
    if (endB <= startB) return null;
    return {
      a: sliceStats(frame, startA, endA),
      b: sliceStats(frame, startB, endB),
      rangeA: `${frame.dates[startA]} → ${frame.dates[endA]}`,
      rangeB: `${frame.dates[startB]} → ${frame.dates[endB]}`,
    };
  }, [frame, length]);

  const overlay = useMemo(() => {
    if (!frame || !stats) return [];
    const n = frame.dates.length;
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const ia = n - length + i;
      const ib = n - 2 * length + i;
      const point = { day: i - length + 1 };
      if (ia >= 0 && frame.closes[n - length] > 0)
        point.a = (frame.closes[ia] / frame.closes[n - length]) * 100;
      if (ib >= 0 && frame.closes[n - 2 * length] > 0)
        point.b = (frame.closes[ib] / frame.closes[n - 2 * length]) * 100;
      out.push(point);
    }
    return out.filter((p) => p.a != null || p.b != null);
  }, [frame, stats, length]);

  if (!activeId) return <NoDatasetState />;
  if (pricesQuery.loading && !pricesQuery.data)
    return <LoadingState label="DERIVING PERIODS" />;
  if (pricesQuery.error && !pricesQuery.data)
    return (
      <ErrorState
        message={pricesQuery.error.message}
        status={pricesQuery.error.status}
        onRetry={pricesQuery.refetch}
      />
    );
  if (!stats)
    return (
      <EmptyState
        title="INSUFFICIENT DATA"
        hint={`PERIOD A/B needs at least ${length * 2} observations; this dataset has fewer.`}
      />
    );

  const defs = [
    { key: "ret", label: "PERIOD RETURN", fmt: (v) => formatSignedPercent(v), get: (s) => s.ret },
    { key: "vol", label: "VOLATILITY (ANN.)", fmt: (v) => formatPercent(v), get: (s) => s.volAnn },
    { key: "dd", label: "MAX DRAWDOWN IN PERIOD", fmt: (v) => formatSignedPercent(v), get: (s) => s.maxDD },
    { key: "trend", label: "TREND STRENGTH (VS MA20)", fmt: (v) => formatSignedPercent(v), get: (s) => s.trend },
  ];

  return (
    <>
      <TerminalPanel
        title="Period Setup"
        subtitle="PERIOD A = most recent window of the active dataset · PERIOD B = the immediately preceding window"
      >
        <div className="chip-row">
          <span className="ctx-label">Length</span>
          {PERIOD_LENGTHS.map((l) => (
            <button
              key={l}
              type="button"
              className={`chip-btn${l === length ? " active" : ""}`}
              onClick={() => setLength(l)}
            >
              {l}D
            </button>
          ))}
          <span style={{ marginLeft: "auto" }} className="ctx-value">
            A: {stats.rangeA} · B: {stats.rangeB}
          </span>
        </div>
      </TerminalPanel>

      <div className="grid-2">
        <TerminalPanel title="Head-to-Head Metrics" subtitle="Biscuit = Period B · Burgundy = Period A (current)">
          {defs.map((def) => (
            <TwoSidedRow
              key={def.key}
              label={def.label}
              valueA={def.get(stats.b)}
              valueB={def.get(stats.a)}
              textA={def.get(stats.b) != null ? def.fmt(def.get(stats.b)) : "N/A"}
              textB={def.get(stats.a) != null ? def.fmt(def.get(stats.a)) : "N/A"}
            />
          ))}
        </TerminalPanel>

        <TerminalPanel title="Statistical Difference" subtitle="Current window minus prior window">
          <table className="dna-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ textAlign: "right" }}>Δ (A − B)</th>
                <th style={{ textAlign: "right" }}>A</th>
                <th style={{ textAlign: "right" }}>B</th>
              </tr>
            </thead>
            <tbody>
              {diffRows(defs, (d) => d.get(stats.a), (d) => d.get(stats.b)).map((row) => (
                <tr key={row.label}>
                  <td className="text-cell" style={{ color: "var(--muted)" }}>{row.label}</td>
                  <td style={{ textAlign: "right" }} className={row.abs >= 0 ? "num-pos" : "num-neg"}>
                    {row.fmt(row.abs)}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.fmt(row.a)}</td>
                  <td style={{ textAlign: "right" }}>{row.fmt(row.b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TerminalPanel>
      </div>

      <TerminalPanel title="Rebased Overlay" subtitle="Both periods start at 100 on day −length+1">
        {overlay.length ? (
          <DnaChart height={280}>
            <LineChart data={overlay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 5" vertical={false} />
              <XAxis dataKey="day" tick={AXIS_STYLE} tickLine={false} minTickGap={30} />
              <YAxis tick={AXIS_STYLE} tickLine={false} width={52} domain={["auto", "auto"]} />
              <Tooltip content={<TooltipBox formatter={(e) => `${e.name}: ${Number(e.value).toFixed(2)}`} />} />
              <Line type="monotone" dataKey="b" name="PERIOD B (prior)" stroke={CHART_COLORS.biscuit} strokeWidth={1.3} dot={false} animationDuration={360} />
              <Line type="monotone" dataKey="a" name="PERIOD A (current)" stroke={CHART_COLORS.primary} strokeWidth={1.6} dot={false} animationDuration={360} />
            </LineChart>
          </DnaChart>
        ) : (
          <LoadingState label="BUILDING OVERLAY" />
        )}
      </TerminalPanel>

      <p className="disclaimer-text">
        All period statistics are computed client-side from genuine price rows returned by
        the backend ({activeDataset?.filename ?? "dataset"}, {activeDataset?.row_count} rows).
        Percentile context available on the Overview and Heatmaps sections.
      </p>
    </>
  );
}
