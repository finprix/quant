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
} from "recharts";
import { DnaChart, AXIS_STYLE, TooltipBox, CHART_COLORS } from "../components/charts/primitives.jsx";
import { formatSignedPercent, formatPercent } from "../lib/format.js";

const LOOKBACKS = [30, 45, 60, 90];

function toneCell(value) {
  if (value == null) return "";
  return value >= 0 ? "num-pos" : "num-neg";
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
