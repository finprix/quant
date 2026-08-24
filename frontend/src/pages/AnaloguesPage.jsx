import { useMemo, useState } from "react";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  NoDatasetState,
} from "../components/states/States.jsx";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { DnaChart, AXIS_STYLE, TooltipBox, CHART_COLORS } from "../components/charts/primitives.jsx";
import { formatSignedPercent, formatPercent } from "../lib/format.js";

const LOOKBACKS = [30, 45, 60, 90];
const FORWARD_HORIZON = 20;

function toneCell(value) {
  if (value == null) return "";
  return value >= 0 ? "num-pos" : "num-neg";
}

function ForwardPathTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <p style={{ margin: "0 0 4px" }} className="mono">T+{label}</p>
      <p style={{ margin: 0 }} className="mono">
        <span style={{ color: "#cfa452" }}>Median: </span>
        {(payload.find((e) => e.dataKey === "median")?.value * 100 ?? 0).toFixed(2)}%
      </p>
      <p style={{ margin: 0 }} className="fineprint">
        {payload.filter((e) => e.dataKey !== "median").length} paths
      </p>
    </div>
  );
}

/**
 * Normalized forward paths for the top analogues: % change over the
 * FORWARD_HORIZON sessions following each analogue end date, plus a
 * session-wise median. Pure frontend computation over stored prices.
 */
function buildForwardPaths(rows, matches, horizon = FORWARD_HORIZON) {
  if (!Array.isArray(rows) || rows.length === 0 || matches.length === 0) {
    return null;
  }
  const indexByDate = new Map(
    rows.map((r, i) => [String(r.date).slice(0, 10), i]),
  );
  const series = [];
  let usable = 0;
  for (const match of matches.slice(0, 8)) {
    const endIdx = indexByDate.get(String(match.end_date).slice(0, 10));
    if (endIdx == null || endIdx + 1 >= rows.length) continue;
    const base = rows[endIdx].close;
    if (!(base > 0)) continue;
    const path = [];
    for (let j = 1; j <= horizon; j += 1) {
      const idx = endIdx + j;
      path.push(idx < rows.length ? rows[idx].close / base - 1 : null);
    }
    series.push(path);
    usable += 1;
  }
  if (usable === 0) return null;

  const data = [];
  const keys = series.map((_, i) => `p${i}`);
  for (let j = 0; j < horizon; j += 1) {
    const point = { t: j + 1 };
    const vals = [];
    keys.forEach((key, i) => {
      const v = series[i][j];
      point[key] = v == null ? null : Number((v * 100).toFixed(3));
      if (v != null) vals.push(v);
    });
    if (vals.length) {
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      point.median = Number(
        ((vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2) * 100).toFixed(3),
      );
    } else {
      point.median = null;
    }
    data.push(point);
  }
  return { data, keys };
}

/** Normalized overlay: current window vs analogue window (+forward tail), rebased to 100 at day 0. */
function buildOverlay(rows, match, lookback) {
  const dated = new Map(rows.map((r, i) => [String(r.date).slice(0, 10), i]));
  const startIdx = dated.get(String(match.start_date).slice(0, 10));
  const endIdx = dated.get(String(match.end_date).slice(0, 10));
  if (startIdx == null || endIdx == null || endIdx <= startIdx) return [];
  const base = rows[endIdx].close;
  const out = [];
  const span = endIdx - startIdx;
  const fwdLimit = Math.min(endIdx + 25, rows.length - 1);
  for (let i = startIdx; i <= fwdLimit; i += 1) {
    const dayOffset = i - endIdx;
    const point = { day: String(dayOffset) };
    if (base > 0) point.analogue = (rows[i].close / base) * 100;
    const curIdx = rows.length - 1 + dayOffset;
    const curBaseIdx = rows.length - 1;
    if (curIdx >= curBaseIdx - span && curIdx >= 0 && rows[curBaseIdx].close > 0) {
      point.current = (rows[curIdx].close / rows[curBaseIdx].close) * 100;
    }
    out.push(point);
  }
  return out;
}

export default function AnaloguesPage() {
  const { activeId, activeDataset } = useDatasets();
  const [lookback, setLookback] = useState(60);
  const [topN, setTopN] = useState(8);
  const [selectedRank, setSelectedRank] = useState(null);

  const basePath = activeId ? `/datasets/${activeId}` : null;
  const query = useApiData(
    activeId
      ? `/datasets/${activeId}/analogues?lookback=${lookback}&top_n=${topN}`
      : null,
  );
  const pricesQuery = useApiData(basePath ? `${basePath}/prices` : null);

  const matches = query.data?.analogues ?? [];

  const selected = useMemo(
    () => matches.find((m) => m.rank === selectedRank) ?? null,
    [matches, selectedRank],
  );

  const overlay = useMemo(() => {
    const rows = pricesQuery.data?.prices;
    if (!rows || !selected) return [];
    return buildOverlay(rows, selected, lookback);
  }, [pricesQuery.data, selected, lookback]);

  const forwardPaths = useMemo(() => {
    const rows = pricesQuery.data?.prices;
    if (!rows || matches.length === 0) return null;
    return buildForwardPaths(rows, matches);
  }, [pricesQuery.data, matches]);

  if (!activeId) {
    return (
      <div className="page">
        <SectionHeader title="Historical Analogues" />
        <NoDatasetState />
      </div>
    );
  }

  const loading = query.loading && !query.data;

  return (
    <div className="page">
      <SectionHeader
        title="Historical Analogues"
        desc="Find periods whose statistical DNA most closely resembles the present."
        right={
          <>
            <span className="ctx-label">Lookback</span>
            <div className="chip-row">
              {LOOKBACKS.map((lb) => (
                <button
                  key={lb}
                  type="button"
                  className={`chip-btn${lb === lookback ? " active" : ""}`}
                  onClick={() => setLookback(lb)}
                >
                  {lb}D
                </button>
              ))}
            </div>
            <span className="ctx-label">Top</span>
            <select
              className="control"
              style={{ width: 70 }}
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
            >
              {[5, 8, 12, 15].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </>
        }
      />

      {loading ? (
        <LoadingState label="SCANNING HISTORY" />
      ) : query.error && !query.data ? (
        <ErrorState
          message={query.error.message}
          status={query.error.status}
          onRetry={query.refetch}
        />
      ) : matches.length === 0 ? (
        <EmptyState
          title="NO ANALOGUES FOUND"
          hint={`Only ${query.data?.candidates_evaluated ?? 0} candidate windows were available before the current one. Upload a longer history for meaningful analogue detection.`}
        />
      ) : (
        <>
          <MetricStrip
            items={[
              { label: "Candidates Evaluated", value: query.data.candidates_evaluated },
              { label: "Matches Shown", value: matches.length },
              {
                label: "Best Similarity",
                value: formatPercent(matches[0]?.similarity_score),
                tone: "biscuit",
              },
              {
                label: "Median 20D Outcome",
                value: (() => {
                  const vals = matches
                    .map((m) => m.subsequent_market_action?.return_after_20_days)
                    .filter((v) => typeof v === "number")
                    .sort((a, b) => a - b);
                  if (!vals.length) return "N/A";
                  const mid = Math.floor(vals.length / 2);
                  const med = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
                  return formatSignedPercent(med);
                })(),
              },
              {
                label: "Positive 20D Frequency",
                value: (() => {
                  const vals = matches
                    .map((m) => m.subsequent_market_action?.return_after_20_days)
                    .filter((v) => typeof v === "number");
                  if (!vals.length) return "N/A";
                  return formatPercent(vals.filter((v) => v > 0).length / vals.length);
                })(),
              },
            ]}
          />

          {forwardPaths ? (
            <TerminalPanel
              title="FORWARD PATHS AFTER ANALOGUES"
              subtitle="Normalized to 0% at each analogue end date · median in gold"
            >
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={forwardPaths.data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#1e2632" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    stroke="#3a4a5f"
                    tick={{ fill: "#6b7a8d", fontSize: 11, fontFamily: "Consolas, monospace" }}
                    tickFormatter={(t) => `T+${t}`}
                  />
                  <YAxis
                    stroke="#3a4a5f"
                    tick={{ fill: "#6b7a8d", fontSize: 11, fontFamily: "Consolas, monospace" }}
                    width={64}
                    tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  />
                  <Tooltip content={<ForwardPathTooltip />} />
                  <ReferenceLine y={0} stroke="#3a4a5f" />
                  {forwardPaths.keys.map((key, i) => (
                    <Line
                      key={key}
                      dataKey={key}
                      name={`#${i + 1}`}
                      stroke="#44546a"
                      strokeWidth={1}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                  <Line
                    dataKey="median"
                    name="Median path"
                    stroke="#cfa452"
                    strokeWidth={2.4}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="fineprint">
                Each grey line tracks the market over the {FORWARD_HORIZON} sessions
                following a historical analogue. The gold line is the session-wise
                median. Dispersion between grey lines is the uncertainty.
              </p>
            </TerminalPanel>
          ) : null}

          <TerminalPanel title="Analogue Matches" subtitle="Ranked by statistical distance to the current window" flush>
            <div style={{ overflowX: "auto" }}>
              <table className="dna-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Period</th>
                    <th style={{ textAlign: "right" }}>Similarity</th>
                    <th style={{ textAlign: "right" }}>5D After</th>
                    <th style={{ textAlign: "right" }}>10D After</th>
                    <th style={{ textAlign: "right" }}>20D After</th>
                    <th style={{ textAlign: "right" }}>20D Spread*</th>
                    <th style={{ textAlign: "right" }}>Vol (ann.)</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => {
                    const fwd = m.subsequent_market_action ?? {};
                    const spread =
                      typeof fwd.max_favourable_move_20d === "number" &&
                      typeof fwd.max_adverse_move_20d === "number"
                        ? fwd.max_favourable_move_20d - fwd.max_adverse_move_20d
                        : null;
                    return (
                      <tr
                        key={m.rank}
                        className={`clickable${selectedRank === m.rank ? " selected" : ""}`}
                        onClick={() =>
                          setSelectedRank(selectedRank === m.rank ? null : m.rank)
                        }
                      >
                        <td>{String(m.rank).padStart(2, "0")}</td>
                        <td className="text-cell">{m.start_date} → {m.end_date}</td>
                        <td style={{ textAlign: "right" }} className="num-pos">
                          {formatPercent(m.similarity_score)}
                        </td>
                        <td style={{ textAlign: "right" }} className={toneCell(fwd.return_after_5_days)}>
                          {formatSignedPercent(fwd.return_after_5_days)}
                        </td>
                        <td style={{ textAlign: "right" }} className={toneCell(fwd.return_after_10_days)}>
                          {formatSignedPercent(fwd.return_after_10_days)}
                        </td>
                        <td style={{ textAlign: "right" }} className={toneCell(fwd.return_after_20_days)}>
                          {formatSignedPercent(fwd.return_after_20_days)}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {spread != null ? formatPercent(spread) : "N/A"}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {formatPercent(m.characteristics?.annualized_volatility)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </TerminalPanel>

          {selected ? (
            <div className="grid-2">
              <TerminalPanel
                title={`Analogue #${String(selected.rank).padStart(2, "0")} Overlay`}
                subtitle={`${selected.start_date} → ${selected.end_date}, rebased to 100 at window end · dashed continuation = what followed`}
              >
                {overlay.length ? (
                  <DnaChart height={280}>
                    <LineChart data={overlay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 5" vertical={false} />
                      <XAxis dataKey="day" tick={AXIS_STYLE} tickLine={false} minTickGap={30} />
                      <YAxis tick={AXIS_STYLE} tickLine={false} width={48} domain={["auto", "auto"]} />
                      <Tooltip content={<TooltipBox formatter={(e) => `${e.name}: ${Number(e.value).toFixed(2)}`} />} />
                      <Line type="monotone" dataKey="current" name="CURRENT" stroke={CHART_COLORS.primary} strokeWidth={1.6} dot={false} animationDuration={380} />
                      <Line type="monotone" dataKey="analogue" name="ANALOGUE" stroke={CHART_COLORS.biscuit} strokeWidth={1.4} strokeDasharray="4 3" dot={false} animationDuration={380} />
                    </LineChart>
                  </DnaChart>
                ) : (
                  <EmptyState title="OVERLAY UNAVAILABLE" hint="Price rows for the matched period are not present." />
                )}
              </TerminalPanel>

              <TerminalPanel title="Similarity Decomposition" subtitle="Matched window features vs current window">
                <table className="dna-table">
                  <thead>
                    <tr>
                      <th>Feature</th>
                      <th style={{ textAlign: "right" }}>Analogue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(selected.characteristics ?? {}).map(([k, v]) => (
                      <tr key={k}>
                        <td className="text-cell" style={{ color: "var(--muted)" }}>{k.replace(/_/g, " ").toUpperCase()}</td>
                        <td style={{ textAlign: "right" }}>
                          {typeof v === "number" ? formatPercent(v) : String(v ?? "N/A")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(selected.subsequent_market_action?.note) ? (
                  <p className="disclaimer-text" style={{ marginTop: 10 }}>{selected.subsequent_market_action.note}</p>
                ) : null}
              </TerminalPanel>
            </div>
          ) : null}

          <p className="disclaimer-text">
            * 20D spread = maximum favourable move minus maximum adverse move over the
            20 days following each analogue — a dispersion indicator, not a forecast.
            Forward outcomes are historical observations only.
          </p>
        </>
      )}
    </div>
  );
}
