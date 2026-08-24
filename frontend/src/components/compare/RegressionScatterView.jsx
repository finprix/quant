import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SectionPanel, StatTile } from "../ui/Ui.jsx";
import { EmptyState } from "../states/States.jsx";
import { formatNumber, formatSignedPercent, NA } from "../../lib/format.js";

export default function RegressionScatterView({ correlation }) {
  const focus = correlation?.focus;
  const regression = focus?.regression_a_relative_to_b;
  const points = focus?.scatter?.points ?? [];

  const fitted = useMemo(() => {
    if (!regression || regression.beta === null || !points.length) return [];
    const xs = points.map((point) => point.return_b);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    // residual_mean_daily is the OLS intercept of the fitted line.
    const intercept = regression.residual_mean_daily ?? 0;
    return [
      { retB: minX, fit: intercept + regression.beta * minX },
      { retB: maxX, fit: intercept + regression.beta * maxX },
    ];
  }, [regression, points]);

  if (!focus || !regression) {
    return (
      <SectionPanel
        title="Relative Regression"
        subtitle="Historical OLS regression of one dataset's daily returns on another's."
      >
        <EmptyState
          title="NO PAIR FOCUS"
          hint="Pick a pair in the rolling-correlation panel to load the regression view."
        />
      </SectionPanel>
    );
  }

  const scatterData = points.map((point) => ({
    retB: point.return_b,
    retA: point.return_a,
  }));

  return (
    <SectionPanel
      title="Relative Regression"
      subtitle={`A = #${correlation.focus.dataset_a} relative to B = #${correlation.focus.dataset_b}. Historical regression statistics over past data only - not guaranteed excess return.`}
    >
      <div className="stat-grid">
        <StatTile
          label="Beta (A on B)"
          value={formatNumber(regression.beta, 3)}
          detail="Cov(A,B) / Var(B)"
        />
        <StatTile
          label="R²"
          value={regression.r_squared === null ? NA : formatNumber(regression.r_squared, 3)}
          detail="share of variance explained historically"
        />
        <StatTile
          label="Residual volatility"
          value={formatNumber(regression.residual_volatility, 4)}
          detail="daily, sample std of residuals"
        />
        <StatTile
          label="Residual mean / day"
          value={formatSignedPercent(regression.residual_mean_daily)}
          detail="OLS intercept; descriptive only"
        />
        <StatTile
          label="Observations"
          value={String(regression.observations ?? focus.overlap_days ?? NA)}
          detail="overlapping daily returns"
        />
      </div>

      {scatterData.length === 0 ? (
        <EmptyState title="INSUFFICIENT OVERLAP" hint="No aligned daily-return pairs to plot." />
      ) : (
        <>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart margin={{ top: 10, right: 18, bottom: 12, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                <XAxis
                  dataKey="retB"
                  type="number"
                  name="Return B"
                  tickFormatter={(value) => formatNumber(value * 100, 1)}
                  stroke="#64748b"
                  fontSize={11}
                  label={{ value: "Daily return B (%)", position: "insideBottom", offset: -8, fill: "#64748b", fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="retA"
                  name="Return A"
                  tickFormatter={(value) => formatNumber(value * 100, 1)}
                  stroke="#64748b"
                  fontSize={11}
                />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }}
                  formatter={(value) => formatNumber(value * 100, 3)}
                />
                <ReferenceLine y={0} stroke="#475569" />
                <ReferenceLine x={0} stroke="#475569" />
                <Scatter
                  data={scatterData}
                  name="Daily returns"
                  fill="rgba(56, 189, 248, 0.55)"
                />
                {fitted.length === 2 ? (
                  <Line
                    data={fitted}
                    dataKey="fit"
                    name="Fitted line"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="muted small">
            Scatter uses daily returns ({focus.scatter.total_points} aligned
            observations{focus.scatter.downsampled ? `, ${focus.scatter.returned_points} plotted` : ""}),
            never raw prices.
          </p>
        </>
      )}
    </SectionPanel>
  );
}
