import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";

export const CHART_COLORS = {
  primary: "#a62b3d",
  primarySoft: "rgba(166, 43, 61, 0.28)",
  biscuit: "#c8ae8d",
  biscuitSoft: "rgba(200, 174, 141, 0.22)",
  up: "#79a882",
  down: "#c9695c",
  grid: "#292326",
  axis: "#6a625f",
  tooltipBg: "#131215",
  tooltipBorder: "#39302d",
};

const AXIS_STYLE = {
  stroke: CHART_COLORS.axis,
  fontSize: 10,
  fontFamily: "IBM Plex Mono, monospace",
};

function TooltipBox({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: CHART_COLORS.tooltipBg,
        border: `1px solid ${CHART_COLORS.tooltipBorder}`,
        borderRadius: 2,
        padding: "7px 10px",
        fontSize: 11,
      }}
    >
      <div
        style={{
          color: "#8e8581",
          fontFamily: "Barlow Condensed, sans-serif",
          letterSpacing: "0.12em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {payload.map((entry) => (
        <div
          key={entry.dataKey}
          className="mono"
          style={{ color: entry.color || "#e7e1dc", lineHeight: 1.5 }}
        >
          {formatter ? formatter(entry) : `${entry.name}: ${entry.value}`}
        </div>
      ))}
    </div>
  );
}

/** Standard dark terminal chart container. */
export function DnaChart({ height = 260, children }) {
  return (
    <div className="chart-enter" style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export { AXIS_STYLE, TooltipBox };

/**
 * Price timeline with optional drawdown overlay.
 * data: [{ date, close, drawdown? }] (drawdown in fractional units)
 */
export function PriceTimeline({ data, height = 300, showDrawdown = false, yDomain = ["auto", "auto"] }) {
  return (
    <DnaChart height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="dnaPriceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity={0.35} />
            <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 5" vertical={false} />
        <XAxis dataKey="date" tick={AXIS_STYLE} tickLine={false} minTickGap={64} />
        <YAxis
          domain={yDomain}
          tick={AXIS_STYLE}
          tickLine={false}
          width={58}
          tickFormatter={(v) => Number(v).toFixed(0)}
        />
        <Tooltip content={<TooltipBox />} />
        <Area
          type="monotone"
          dataKey="close"
          name="CLOSE"
          stroke={CHART_COLORS.primary}
          strokeWidth={1.4}
          fill="url(#dnaPriceFill)"
          animationDuration={420}
        />
        {showDrawdown ? (
          <Area
            type="monotone"
            dataKey="drawdown"
            name="DRAWDOWN %"
            yAxisId={0}
            stroke={CHART_COLORS.biscuit}
            strokeWidth={1}
            fill="transparent"
            dot={false}
            isAnimationActive={false}
          />
        ) : null}
        <ReferenceLine y={0} stroke={CHART_COLORS.grid} />
      </AreaChart>
    </DnaChart>
  );
}
