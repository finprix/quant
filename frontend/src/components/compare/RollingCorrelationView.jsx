import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SectionPanel, StatTile } from "../ui/Ui.jsx";
import { EmptyState } from "../states/States.jsx";
import { formatNumber, NA } from "../../lib/format.js";

function buildSeries(focus) {
  if (!focus) return [];
  const dates20 = focus["20"]?.dates ?? [];
  const values20 = focus["20"]?.values ?? [];
  const values60 = focus["60"]?.values ?? [];
  return dates20.map((date, index) => ({
    date,
    corr20: values20[index] ?? null,
    corr60: values60[index] ?? null,
  }));
}

export default function RollingCorrelationView({
  datasets,
  correlation,
  pair,
  onPairChange,
}) {
  const options = datasets.map((dataset) => ({
    id: dataset.id,
    label: `#${dataset.id} · ${dataset.filename}`,
  }));
  const safePair =
    Array.isArray(pair) &&
    pair.length === 2 &&
    pair[0] !== pair[1] &&
    datasets.some((d) => d.id === pair[0]) &&
    datasets.some((d) => d.id === pair[1])
      ? pair
      : null;

  const focus = correlation?.focus;
  const series = useMemo(() => buildSeries(focus), [focus]);

  const summary20 = focus?.["20_summary"];
  const summary60 = focus?.["60_summary"];

  const handleSelect = (index, value) => {
    const next = index === 0 ? [Number(value), pair[1]] : [pair[0], Number(value)];
    onPairChange?.(next);
  };

  if (datasets.length < 2) {
    return (
      <SectionPanel
        title="Rolling Correlation"
        subtitle="Select at least two datasets to inspect rolling co-movement."
      >
        <EmptyState
          title="PAIR SELECTION REQUIRED"
          hint="Rolling correlation needs exactly two datasets."
        />
      </SectionPanel>
    );
  }

  return (
    <SectionPanel
      title="Rolling Correlation"
      subtitle="20-day and 60-day rolling Pearson correlation of daily returns for one dataset pair."
    >
      <div className="control-row">
        <label className="control">
          <span className="mono">A</span>
          <select
            value={safePair ? String(safePair[0]) : ""}
            onChange={(event) => handleSelect(0, event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          <span className="mono">B</span>
          <select
            value={safePair ? String(safePair[1]) : ""}
            onChange={(event) => handleSelect(1, event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!safePair ? (
        <EmptyState
          title="PICK TWO DIFFERENT DATASETS"
          hint="Choose two distinct datasets above to compute the rolling view."
        />
      ) : !focus ? (
        <EmptyState
          title="NO FOCUS PAIR LOADED"
          hint="The rolling series loads with the correlation request; adjust the pair."
        />
      ) : (
        <>
          <div className="stat-grid">
            <StatTile
              label="20d latest / mean"
              value={`${formatNumber(summary20?.latest)} / ${formatNumber(summary20?.mean)}`}
              detail={`min ${formatNumber(summary20?.min)} · max ${formatNumber(summary20?.max)}`}
            />
            <StatTile
              label="60d latest / mean"
              value={`${formatNumber(summary60?.latest)} / ${formatNumber(summary60?.mean)}`}
              detail={`min ${formatNumber(summary60?.min)} · max ${formatNumber(summary60?.max)}`}
            />
            <StatTile
              label="Overlap observations"
              value={String(focus.overlap_days ?? NA)}
              detail="shared trading days after alignment"
            />
          </div>

          <div className="chart-box">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={series} margin={{ top: 10, right: 18, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                <XAxis dataKey="date" minTickGap={48} stroke="#64748b" fontSize={11} />
                <YAxis domain={[-1, 1]} stroke="#64748b" fontSize={11} ticks={[-1, -0.5, 0, 0.5, 1]} />
                <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }} />
                <ReferenceLine y={0} stroke="#475569" />
                <Line
                  type="monotone"
                  dataKey="corr20"
                  name="20-day"
                  stroke="#38bdf8"
                  dot={false}
                  connectNulls={false}
                  strokeWidth={1.6}
                />
                <Line
                  type="monotone"
                  dataKey="corr60"
                  name="60-day"
                  stroke="#c084fc"
                  dot={false}
                  connectNulls={false}
                  strokeWidth={1.6}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="muted small">
            Series start once the rolling window fills (first 19/59 observations
            are blank by construction).
          </p>
        </>
      )}
    </SectionPanel>
  );
}
