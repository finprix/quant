import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SectionPanel } from "../components/ui/Ui.jsx";
import { formatNumber, formatPrice } from "../lib/format.js";
import CandleChart from "./CandleChart.jsx";

function sma(values, window) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function rollingStd(returns, window) {
  const out = new Array(returns.length).fill(null);
  for (let i = 0; i < returns.length; i += 1) {
    const start = Math.max(0, i - window + 1);
    const slice = returns.slice(start, i + 1);
    if (slice.length === window) {
      const mean = slice.reduce((a, b) => a + b, 0) / window;
      const variance =
        slice.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (window - 1);
      out[i] = Math.sqrt(variance * 252);
    }
  }
  return out;
}

function drawdownSeries(closes) {
  let peak = closes[0];
  return closes.map((close) => {
    peak = Math.max(peak, close);
    return close / peak - 1;
  });
}

const SECONDARY_VIEWS = [
  { key: "volume", label: "Volume" },
  { key: "drawdown", label: "Drawdown" },
  { key: "volatility", label: "Rolling vol" },
  { key: "none", label: "None" },
];

function TerminalTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <p style={{ margin: "0 0 4px" }} className="mono">{label}</p>
      {payload
        .filter((entry) => entry.value !== null && entry.value !== undefined)
        .map((entry) => (
          <p key={entry.dataKey} style={{ margin: 0 }} className="mono">
            <span style={{ color: entry.color }}>
              {entry.name}:{" "}
              {entry.dataKey === "volume"
                ? formatNumber(entry.value, 0)
                : entry.dataKey === "drawdown" || entry.dataKey === "rolling_vol"
                  ? `${(entry.value * 100).toFixed(2)}%`
                  : formatPrice(entry.value)}
            </span>
          </p>
        ))}
    </div>
  );
}

export default function PriceChart({ prices }) {
  const [secondary, setSecondary] = useState("volume");
  const [showMa20, setShowMa20] = useState(true);
  const [showMa50, setShowMa50] = useState(true);
  const [style, setStyle] = useState("line"); // "line" | "candles"

  const data = useMemo(() => {
    if (!Array.isArray(prices) || prices.length === 0) return [];
    const closes = prices.map((row) => row.close);
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);

    const dailyReturns = closes.map((close, i) =>
      i === 0 ? null : close / closes[i - 1] - 1,
    );
    const rollingVol = rollingStd(
      dailyReturns.map((r) => (r === null ? 0 : r)).slice(1),
      20,
    );
    const drawdowns = drawdownSeries(closes);

    return prices.map((row, i) => ({
      date: row.date?.slice(0, 10),
      close: row.close,
      open: row.open,
      high: row.high,
      low: row.low,
      volume: row.volume,
      ma20: ma20[i],
      ma50: ma50[i],
      drawdown: drawdowns[i],
      rolling_vol: i >= 20 ? rollingVol[i - 20] : null,
    }));
  }, [prices]);

  if (data.length === 0) {
    return (
      <SectionPanel title="Price History">
        <p className="table-empty">No stored price rows for this dataset.</p>
      </SectionPanel>
    );
  }

  const hasMa50 = data.some((row) => row.ma50 !== null);

  return (
    <SectionPanel
      title="Price History"
      subtitle={`Close with MA20${hasMa50 ? "/MA50" : ""} · ${data.length} sessions`}
      actions={
        <>
          <div className="control-row" role="group" aria-label="Chart style">
            {[{ key: "line", label: "Line" }, { key: "candles", label: "Candles" }].map(
              (option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`btn${style === option.key ? " is-active" : ""}`}
                  onClick={() => setStyle(option.key)}
                >
                  {option.label}
                </button>
              ),
            )}
          </div>
          {style === "line" ? (
            <>
              <label className="control">
                <input
                  type="checkbox"
                  checked={showMa20}
                  onChange={(event) => setShowMa20(event.target.checked)}
                />
                <span>MA20</span>
              </label>
              {hasMa50 ? (
                <label className="control">
                  <input
                    type="checkbox"
                    checked={showMa50}
                    onChange={(event) => setShowMa50(event.target.checked)}
                  />
                  <span>MA50</span>
                </label>
              ) : null}
            </>
          ) : null}
          {style === "line" ? (
            <div className="control-row" role="group" aria-label="Secondary series">
              {SECONDARY_VIEWS.map((view) => (
                <button
                  key={view.key}
                  type="button"
                  className={`btn${secondary === view.key ? " is-active" : ""}`}
                  onClick={() => setSecondary(view.key)}
                >
                  {view.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      }
    >
      {style === "candles" ? (
        <>
          <CandleChart prices={prices} height={380} />
          <p className="fineprint">
            Green = session closed up · red = closed down. Wicks span the
            session low\u2013high; older sessions are thinned beyond 180 candles.
          </p>
        </>
      ) : (
        <>
      <ResponsiveContainer width="100%" height={380}>
        <ComposedChart data={data} syncId="market-dna-price" margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e2632" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#3a4a5f"
            tick={{ fill: "#6b7a8d", fontSize: 11, fontFamily: "Consolas, monospace" }}
            minTickGap={48}
          />
          <YAxis
            stroke="#3a4a5f"
            tick={{ fill: "#6b7a8d", fontSize: 11, fontFamily: "Consolas, monospace" }}
            domain={["auto", "auto"]}
            width={64}
            tickFormatter={(value) => formatNumber(value, 0)}
          />
          <Tooltip content={<TerminalTooltip />} />
          <Line
            type="linear"
            dataKey="close"
            name="Close"
            stroke="#e3eaf2"
            strokeWidth={1.4}
            dot={false}
            isAnimationActive={false}
          />
          {showMa20 ? (
            <Line
              type="linear"
              dataKey="ma20"
              name="MA20"
              stroke="#56b8a5"
              strokeWidth={1}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ) : null}
          {showMa50 && hasMa50 ? (
            <Line
              type="linear"
              dataKey="ma50"
              name="MA50"
              stroke="#cfa452"
              strokeWidth={1}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>

      {secondary !== "none" ? (
        <ResponsiveContainer width="100%" height={150}>
          <ComposedChart data={data} syncId="market-dna-price" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e2632" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="#3a4a5f"
              tick={{ fill: "#6b7a8d", fontSize: 10, fontFamily: "Consolas, monospace" }}
              minTickGap={48}
            />
            <YAxis
              stroke="#3a4a5f"
              tick={{ fill: "#6b7a8d", fontSize: 10, fontFamily: "Consolas, monospace" }}
              width={64}
              domain={
                secondary === "drawdown"
                  ? [-1, 0]
                  : ["auto", "auto"]
              }
              tickFormatter={(value) =>
                secondary === "volume"
                  ? formatNumber(value, 0)
                  : `${(value * 100).toFixed(0)}%`
              }
            />
            <Tooltip content={<TerminalTooltip />} />
            {secondary === "volume" ? (
              <Bar dataKey="volume" name="Volume" fill="#24405a" isAnimationActive={false} />
            ) : null}
            {secondary === "drawdown" ? (
              <Line
                type="stepAfter"
                dataKey="drawdown"
                name="Drawdown"
                stroke="#d96a6a"
                strokeWidth={1.2}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {secondary === "volatility" ? (
              <Line
                type="linear"
                dataKey="rolling_vol"
                name="Rolling vol (20d ann.)"
                stroke="#56b8a5"
                strokeWidth={1.2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      ) : null}
        </>
      )}
    </SectionPanel>
  );
}
