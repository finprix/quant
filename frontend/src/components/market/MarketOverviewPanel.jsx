import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApiData } from "../../hooks/useApiData.js";
import { useDatasets } from "../../context/DatasetContext.jsx";
import { TerminalPanel } from "../common/Panels.jsx";
import { StatusBadge } from "../common/StatusBadge.jsx";
import { signedColor } from "../../lib/heatmapData.js";
import { formatPercent, formatSignedPercent } from "../../lib/format.js";

const METRICS = [
  { key: "return_1d", label: "1D", kind: "signed" },
  { key: "return_5d", label: "5D", kind: "signed" },
  { key: "return_20d", label: "20D", kind: "signed" },
  { key: "volatility_20d_annualized", label: "VOLATILITY", kind: "magnitude" },
  { key: "momentum_60d", label: "MOMENTUM", kind: "signed" },
  { key: "drawdown", label: "DRAWDOWN", kind: "negative" },
];

function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(String(iso).includes("T") ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function tileValue(row, metric) {
  const value = row[metric.key];
  if (value == null || Number.isNaN(value)) return null;
  if (metric.kind === "magnitude") return formatPercent(value);
  return formatSignedPercent(value);
}

function tileBackground(value, metric, maxAbs) {
  if (value == null || !maxAbs) return "var(--bg-2)";
  const fraction = Math.min(1, Math.abs(value) / maxAbs);
  if (metric.kind === "magnitude") {
    // Volatility: burgundy intensity only.
    const t = Math.max(0, Math.min(1, fraction));
    return `rgba(166, 43, 61, ${0.08 + 0.7 * t})`;
  }
  if (metric.kind === "negative") {
    // Drawdown: deeper = more burgundy.
    return `rgba(112, 22, 38, ${0.1 + 0.8 * fraction})`;
  }
  return signedColor(maxAbs ? value / maxAbs : 0);
}

/**
 * Real multi-asset market heatmap (Phase N).
 * Values come exclusively from /market/overview (stored MySQL prices).
 */
export default function MarketOverviewPanel() {
  const { selectDataset } = useDatasets();
  const navigate = useNavigate();
  const [metricKey, setMetricKey] = useState("return_1d");

  const overviewQuery = useApiData("/market/overview");
  const instruments = overviewQuery.data?.instruments ?? [];
  const imported = instruments.filter((row) => row.source);

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  const values = useMemo(
    () =>
      imported
        .map((row) => row[metric.key])
        .filter((value) => typeof value === "number" && Number.isFinite(value)),
    [imported, metric],
  );
  const maxAbs = Math.max(...values.map((v) => Math.abs(v)), 1e-9);

  if (overviewQuery.loading && !overviewQuery.data) {
    return (
      <TerminalPanel title="MARKET OVERVIEW">
        <p className="fineprint">Loading stored instruments…</p>
      </TerminalPanel>
    );
  }

  if (overviewQuery.error && !overviewQuery.data) {
    return null; // Overview panel is optional chrome; never block the page.
  }

  return (
    <TerminalPanel
      title="MARKET OVERVIEW"
      subtitle={
        imported.length > 0
          ? `${imported.length} imported instrument${imported.length > 1 ? "s" : ""} · historical data from MySQL`
          : undefined
      }
      actions={undefined}
    >
      <div className="heat-metric-selector">
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`chip-btn${m.key === metricKey ? " active" : ""}`}
            onClick={() => setMetricKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {imported.length === 0 ? (
        <p className="fineprint">
          A genuine multi-asset heatmap appears here once you import instruments
          via FETCH MARKET DATA on the Market Library page. Single-instrument CSV
          analysis remains fully available below.
        </p>
      ) : (
        <div className="market-heatmap">
          {imported.map((row) => {
            const source = row.source ?? {};
            const raw = row[metric.key];
            const text = tileValue(row, metric) ?? "N/A";
            return (
              <button
                key={row.dataset_id}
                type="button"
                className="market-tile"
                style={{ background: tileBackground(raw, metric, maxAbs) }}
                title={`${source.symbol} · last data ${row.end_date}${
                  source.last_updated ? ` · updated ${relativeTime(source.last_updated)}` : ""
                }`}
                onClick={() => {
                  selectDataset(row.dataset_id);
                  navigate("/");
                }}
              >
                <span className="market-tile-symbol mono">{source.symbol}</span>
                <span className="market-tile-value mono">{text}</span>
                <span className="market-tile-fresh">
                  LAST DATA {String(row.end_date).slice(0, 10)}
                  {source.last_updated ? ` · ${relativeTime(source.last_updated)}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <p className="fineprint" style={{ marginTop: 10 }}>
        Historical end-of-day observations — not live quotes. All values computed
        from stored MySQL prices.
      </p>
    </TerminalPanel>
  );
}
