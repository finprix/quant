import { useMemo } from "react";

/**
 * Lightweight SVG candlestick renderer.
 * Kept outside Recharts deliberately: candle geometry needs direct
 * low/high→pixel mapping that the chart library's bar abstraction makes
 * awkward. Shares the terminal palette and stays print-friendly.
 */
export default function CandleChart({ prices, height = 380 }) {
  const W = 1000;
  const H = height;
  const PAD_L = 8;
  const PAD_R = 64;
  const PAD_T = 12;
  const PAD_B = 24;

  const view = useMemo(() => {
    if (!Array.isArray(prices) || prices.length === 0) return null;
    const rows = prices.map((row) => ({
      date: String(row.date).slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }));
    // Cap density: one candle per slot beyond ~180 sessions degrades.
    const maxCandles = 180;
    let shown = rows;
    if (rows.length > maxCandles) {
      const step = Math.ceil(rows.length / maxCandles);
      shown = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of shown) {
      lo = Math.min(lo, r.low);
      hi = Math.max(hi, r.high);
    }
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad;
    hi += pad;

    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const slot = innerW / shown.length;
    const bodyW = Math.max(2, Math.min(14, slot * 0.62));

    const yOf = (price) => PAD_T + ((hi - price) / (hi - lo)) * innerH;
    const xOf = (i) => PAD_L + slot * (i + 0.5);

    const gridLines = [];
    for (let t = 0; t <= 4; t += 1) {
      const price = lo + ((hi - lo) * t) / 4;
      const y = yOf(price);
      gridLines.push({ y, price });
    }

    const candles = shown.map((r, i) => {
      const up = r.close >= r.open;
      const color = up ? "#3fb68b" : "#e05555";
      const cx = xOf(i);
      const yHigh = yOf(r.high);
      const yLow = yOf(r.low);
      const yOpen = yOf(r.open);
      const yClose = yOf(r.close);
      const top = Math.min(yOpen, yClose);
      const bottom = Math.max(yOpen, yClose);
      return {
        key: r.date,
        color,
        cx,
        wickX: cx,
        yHigh,
        yLow,
        bodyY: top,
        bodyH: Math.max(1, bottom - top),
        bodyW,
        label: `${r.date}  O ${r.open}  H ${r.high}  L ${r.low}  C ${r.close}`,
      };
    });

    return { candles, gridLines, xOf, last: shown[shown.length - 1], lastX: xOf(shown.length - 1), lastY: yOf(shown[shown.length - 1].close), firstDate: shown[0].date, lastDate: shown[shown.length - 1].date };
  }, [prices, H]);

  if (!view) {
    return <p className="table-empty">Not enough rows for candlesticks.</p>;
  }

  return (
    <svg
      className="candle-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label="Candlestick chart"
    >
      {view.gridLines.map((g) => (
        <g key={g.y}>
          <line x1={PAD_L} x2={W - PAD_R} y1={g.y} y2={g.y}
                stroke="#1e2632" strokeDasharray="2 4" />
          <text x={W - PAD_R + 6} y={g.y + 3} fill="#6b7a8d"
                fontSize="10" fontFamily="Consolas, monospace">
            {g.price.toFixed(g.price > 100 ? 0 : 2)}
          </text>
        </g>
      ))}
      {view.candles.map((c) => (
        <g key={c.key}>
          <title>{c.label}</title>
          <line x1={c.wickX} x2={c.wickX} y1={c.yHigh} y2={c.yLow}
                stroke={c.color} strokeWidth="1" />
          <rect x={c.cx - c.bodyW / 2} y={c.bodyY} width={c.bodyW}
                height={c.bodyH} fill={c.color} />
        </g>
      ))}
      <circle cx={view.lastX} cy={view.lastY} r="2.5" fill="#e3eaf2" />
      <text x={view.lastX + 6} y={view.lastY - 6} fill="#e3eaf2" fontSize="10"
            fontFamily="Consolas, monospace">
        {view.last.close.toFixed(2)}
      </text>
      <text x={PAD_L} y={H - 8} fill="#6b7a8d" fontSize="10"
            fontFamily="Consolas, monospace">
        {view.firstDate}
      </text>
      <text x={W - PAD_R} y={H - 8} fill="#6b7a8d" fontSize="10"
            textAnchor="end" fontFamily="Consolas, monospace">
        {view.lastDate}
      </text>
    </svg>
  );
}
