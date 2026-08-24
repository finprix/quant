import { Fragment, useMemo, useState } from "react";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { SectionHeader, TerminalPanel } from "../components/common/Panels.jsx";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  NoDatasetState,
} from "../components/states/States.jsx";
import {
  buildTimeMetricMatrix,
  buildHorizonMatrix,
  buildRegimeMatrix,
  buildAnalogueMatrix,
  signedColor,
  magnitudeColor,
} from "../lib/heatmapData.js";
import { formatSignedPercent, formatPercent, formatNumber } from "../lib/format.js";
import "../styles/heatmap.css";

const LAYERS = [
  { key: "timexmetric", label: "TIME × METRIC" },
  { key: "horizons", label: "RETURN HORIZONS" },
  { key: "regime", label: "REGIME" },
  { key: "analogues", label: "ANALOGUE OUTCOMES" },
];

function cellTitle(rowKey, colLabel, cell) {
  if (cell.raw == null) return "No data";
  const formatted = Number.isInteger(cell.raw)
    ? String(cell.raw)
    : formatNumber(cell.raw, 4);
  return `${rowKey} · ${colLabel ?? ""}\nvalue: ${formatted}`;
}

function HeatGrid({ matrix, mode }) {
  if (!matrix.rows.length) {
    return <EmptyState title="NO DATA FOR THIS LAYER" />;
  }
  const nCols = matrix.columnLabels
    ? matrix.columnLabels.length
    : matrix.rows[0]?.cells.length ?? 0;
  return (
    <div style={{ overflowX: "auto" }}>
      <div>
        <div
          className="heat-grid"
          style={{ gridTemplateColumns: `minmax(150px, max-content) repeat(${nCols}, minmax(14px, 1fr))` }}
        >
          <div className="heat-corner" />
          {(matrix.columnLabels ?? []).map((label, i) => (
            <div className="heat-xlabel" key={i} title={String(label)}>
              {typeof label === "string" ? label.slice(2) : ""}
            </div>
          ))}
          {!matrix.columnLabels && nCols > 0
            ? Array.from({ length: nCols }, (_, i) => <div className="heat-xlabel" key={i} />)
            : null}
          {matrix.rows.map((row) => (
            <Fragment key={row.label}>
              <div className="heat-ylabel" title={row.label}>
                {row.label}
              </div>
              {row.cells.map((cell, j) => {
                void j;
                return (
                  <div
                    key={`${row.label}-${j}`}
                    className="heat-cell"
                    title={cellTitle(row.label, matrix.columnLabels?.[j], cell)}
                    style={{
                      background:
                        cell.raw == null
                          ? "var(--bg-0)"
                          : (mode === "magnitude"
                              ? magnitudeColor(Math.abs(cell.display ?? 0))
                              : signedColor(cell.display ?? 0)),
                    }}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="heat-legend">
        <span className="heat-legend-label">
          {mode === "magnitude" ? "LOW" : "NEGATIVE"}
        </span>
        <div className="heat-legend-bar" />
        <span className="heat-legend-label">
          {mode === "magnitude" ? "HIGH" : "POSITIVE"}
        </span>
      </div>
    </div>
  );
}

export default function HeatmapsPage() {
  const { activeId, activeDataset } = useDatasets();
  const [layer, setLayer] = useState("timexmetric");
  const [buckets, setBuckets] = useState(60);

  const pricesQuery = useApiData(activeId ? `/datasets/${activeId}/prices` : null);
  const regimesQuery = useApiData(
    activeId && layer === "regime"
      ? `/datasets/${activeId}/regimes?window_size=60`
      : null,
  );
  const analoguesQuery = useApiData(
    activeId && layer === "analogues"
      ? `/datasets/${activeId}/analogues?lookback=60&top_n=12`
      : null,
  );

  const rows = pricesQuery.data?.prices;

  const timeMetric = useMemo(() => {
    if (!rows || rows.length < 30) return null;
    return buildTimeMetricMatrix(rows, { buckets });
  }, [rows, buckets]);

  const horizons = useMemo(() => {
    if (!rows || rows.length < 80) return null;
    return buildHorizonMatrix(rows, { buckets });
  }, [rows]);

  if (!activeId) {
    return (
      <div className="page">
        <SectionHeader title="Market Heatmaps" />
        <NoDatasetState />
      </div>
    );
  }

  const needsPrices = layer === "timexmetric" || layer === "horizons";
  const regimeMatrix = layer === "regime" ? buildRegimeMatrix(regimesQuery.data) : null;
  const analogueMatrix =
    layer === "analogues" && analoguesQuery.data
      ? buildAnalogueMatrix(analoguesQuery.data)
      : null;

  let body = null;
  if (layer === "regime") {
    if (regimesQuery.loading && !regimesQuery.data) {
      body = <LoadingState label="LOADING REGIME MODEL" />;
    } else if (!regimesQuery.data?.available) {
      body = (
        <EmptyState
          title="INSUFFICIENT DATA"
          hint={regimesQuery.data?.message || "Regime discovery requires more history."}
        />
      );
    } else {
      body = <HeatGrid matrix={regimeMatrix} mode="mixed" />;
    }
  } else if (layer === "analogues") {
    if (analoguesQuery.loading && !analoguesQuery.data) {
      body = <LoadingState label="LOADING ANALOGUE OUTCOMES" />;
    } else if (!analogueMatrix?.rows.length) {
      body = <EmptyState title="NO ANALOGUES AVAILABLE" hint="No analogue matches exist for this dataset yet." />;
    } else {
      body = <HeatGrid matrix={analogueMatrix} mode="mixed" />;
    }
  } else if (pricesQuery.loading && !pricesQuery.data) {
    body = <LoadingState label="DERIVING METRIC SURFACE" />;
  } else if (pricesQuery.error && !pricesQuery.data) {
    body = (
      <ErrorState
        message={pricesQuery.error.message}
        status={pricesQuery.error.status}
        onRetry={pricesQuery.refetch}
      />
    );
  } else if (rows?.length < 30) {
    body = (
      <EmptyState
        title="INSUFFICIENT DATA"
        hint="This analysis requires at least 30 observations."
      />
    );
  } else if (layer === "timexmetric") {
    body = timeMetric ? <HeatGrid matrix={timeMetric} mode="signed" /> : null;
  } else {
    body = horizons ? <HeatGrid matrix={horizons} mode="signed" /> : null;
  }

  return (
    <div className="page">
      <SectionHeader
        title="Market Heatmaps"
        desc={`Statistical surfaces over ${activeDataset?.filename ?? "dataset"} — every cell derived from genuine backend data.`}
      />

      <TerminalPanel flush>
        <div className="panel-body" style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div className="control">
            <label>Layer</label>
            <div className="chip-row">
              {LAYERS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  className={`chip-btn${layer === l.key ? " active" : ""}`}
                  onClick={() => setLayer(l.key)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          {needsPrices ? (
            <div className="control">
              <label>Period Resolution</label>
              <select
                value={buckets}
                onChange={(e) => setBuckets(Number(e.target.value))}
              >
                {[40, 60, 90, 120].map((b) => (
                  <option key={b} value={b}>
                    {b} buckets
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="ctx-item" style={{ border: "none", padding: 0, marginLeft: "auto" }}>
            <span className="ctx-label">Normalization</span>
            <span className="ctx-value">PERCENTILE OF ROW DISTRIBUTION</span>
          </div>
        </div>
      </TerminalPanel>

      <TerminalPanel
        title={LAYERS.find((l) => l.key === layer)?.label ?? ""}
        subtitle={
          layer === "timexmetric"
            ? "Bucket means, percentile-ranked within each metric row · signed metrics diverge at the median"
            : layer === "horizons"
              ? "Forward-return percentiles per horizon across the timeline"
              : layer === "regime"
                ? "Regime profiles and regime-conditioned outcomes"
                : "What followed each historical analogue, colored by outcome"
        }
      >
        {body}
        {layer === "timexmetric" && timeMetric ? (
          <p className="disclaimer-text" style={{ marginTop: 10 }}>
            Hover any cell for its raw value. Returns/momentum/trend are signed
            (burgundy = weak vs history, sage = strong); volatility/drawdown/volume show
            magnitude.
          </p>
        ) : null}
        {layer === "analogues" && analogueMatrix?.rows.length ? (
          <p className="disclaimer-text" style={{ marginTop: 10 }}>
            Forward outcomes are historical observations following similar windows — not
            predictions. Example read: {formatSignedPercent(analogueMatrix.rows[0]?.cells[3]?.raw)} median-window 20D outcome for match #01.
          </p>
        ) : null}
        {layer === "regime" && regimeMatrix?.rows.length ? (
          <p className="disclaimer-text" style={{ marginTop: 10 }}>
            Persistence = historical probability a regime is followed by itself. Forward
            columns are regime-conditioned historical averages.
          </p>
        ) : null}
      </TerminalPanel>
    </div>
  );
}
