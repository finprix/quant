import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SectionPanel } from "../ui/Ui.jsx";
import { formatNumber, formatSignedPercent, NA } from "../../lib/format.js";

const SERIES_COLORS = ["#56b8a5", "#cfa452", "#7f9cc4", "#cf6a76"];
const VIEWS = [
  { key: "normalized", label: "Normalized price" },
  { key: "drawdown", label: "Drawdown" },
  { key: "volatility", label: "Rolling vol" },
];

function rollingAnnualizedVol(closes, window = 20) {
  const out = new Array(closes.length).fill(null);
  const returns = closes.map((close, i) => (i === 0 ? null : close / closes[i - 1] - 1));
  for (let i = window; i < closes.length; i += 1) {
    const slice = returns.slice(i - window + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const variance = slice.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (window - 1);
    out[i] = Math.sqrt(variance * 252);
  }
  return out;
}

/**
 * Rebases every dataset to 100 at the start of the overlapping period and
 * renders normalized price / drawdown / rolling volatility views.
 * All series are derived directly from stored prices; no backend analytics
 * are duplicated beyond these presentation transforms.
 */
export default function NormalizedPerformanceChart({ entries }) {
  // entries: [{ id, filename, prices: [{date, close}], datasetStart }]
  const [view, setView] = useState("normalized");

  const model = useMemo(() => {
    const usable = entries.filter((entry) => Array.isArray(entry.prices) && entry.prices.length > 0);
    if (usable.length === 0) return null;

    const overlapStart = usable
      .map((entry) => String(entry.prices[0].date).slice(0, 10))
      .sort()
      .at(-1);

    const prepared = usable.map((entry, position) => {
      const rows = entry.prices.filter((row) => String(row.date).slice(0, 10) >= overlapStart);
      const closes = rows.map((row) => row.close);
      if (closes.length === 0) return { ...entry, position, aligned: [] };
      const base = closes[0];
      let peak = base;
      const drawdowns = closes.map((close) => {
        peak = Math.max(peak, close);
        return close / peak - 1;
      });
      const vols = rollingAnnualizedVol(closes);
      const aligned = rows.map((row, i) => ({
        date: String(row.date).slice(0, 10),
        value:
          view === "normalized"
            ? (closes[i] / base) * 100
            : view === "drawdown"
              ? drawdowns[i]
              : vols[i],
      }));
      return { ...entry, position, aligned };
    });

    const byDate = new Map();
    for (const series of prepared) {
      for (const point of series.aligned) {
        if (!byDate.has(point.date)) byDate.set(point.date, { date: point.date });
        byDate.get(point.date)[`d${series.id}`] = point.value;
      }
    }
    const chartData = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
    return { overlapStart, chartData, prepared };
  }, [entries, view]);

  if (!model) {
    return (
      <SectionPanel title="Normalized Performance">
        <p className="table-empty">No stored price history available for the selected datasets.</p>
      </SectionPanel>
    );
  }

  const lengths = new Set(model.prepared.filter((p) => p.aligned.length > 0).map((p) => p.aligned.length));

  return (
    <SectionPanel
      title="Normalized Performance"
      subtitle={`Rebased to 100 at ${model.overlapStart} (overlapping period only)`}
      actions={
        <div className="control-row print-hidden" role="group" aria-label="Chart view">
          {VIEWS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`btn${view === option.key ? " is-active" : ""}`}
              onClick={() => setView(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      {lengths.size > 1 ||
      model.prepared.some((p) => p.datasetStart && p.datasetStart !== model.overlapStart) ? (
        <p className="notice">
          Selected datasets cover different histories. The chart is restricted to the
          overlapping period starting {model.overlapStart}; series with shorter coverage
          begin later and show gaps until their data starts.
        </p>
      ) : null}

      <ResponsiveContainer width="100%" height={360}>
        <ComposedChart data={model.chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e2632" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#3a4a5f"
            tick={{ fill: "#6b7a8d", fontSize: 11, fontFamily: "Consolas, monospace" }}
            minTickGap={56}
          />
          <YAxis
            stroke="#3a4a5f"
            tick={{ fill: "#6b7a8d", fontSize: 11, fontFamily: "Consolas, monospace" }}
            width={64}
            domain={view === "drawdown" ? [-1, 0] : ["auto", "auto"]}
            tickFormatter={(value) =>
              view === "normalized"
                ? formatNumber(value, 0)
                : `${(value * 100).toFixed(0)}%`
            }
          />
          <Tooltip
            formatter={(value, name) => [
              view === "normalized" ? formatNumber(value, 2) : formatSignedPercent(value),
              name,
            ]}
            contentStyle={{
              background: "#0c1017",
              border: "1px solid #2c3a4d",
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {model.prepared
            .filter((series) => series.aligned.length > 0)
            .map((series) =>
              view === "normalized" ? (
                <Line
                  key={series.id}
                  type="linear"
                  dataKey={`d${series.id}`}
                  name={series.filename}
                  stroke={SERIES_COLORS[series.position % SERIES_COLORS.length]}
                  strokeWidth={1.4}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : (
                <Bar
                  key={series.id}
                  dataKey={`d${series.id}`}
                  name={series.filename}
                  fill={SERIES_COLORS[series.position % SERIES_COLORS.length]}
                  fillOpacity={0.75}
                  isAnimationActive={false}
                />
              ),
            )}
        </ComposedChart>
      </ResponsiveContainer>
      <p className="hint-text">
        {view === "normalized"
          ? "Each series is rebased to 100 at the first overlapping session; raw price levels are never compared."
          : view === "drawdown"
            ? "Drawdown is measured from each series' running peak within the overlap window."
            : "Rolling volatility uses a 20-session annualized standard deviation of daily returns."}{" "}
        Datasets missing early overlap dates appear once their own history begins.
        Values marked {NA} are unavailable sessions.
      </p>
    </SectionPanel>
  );
}
