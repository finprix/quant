import { useEffect, useMemo, useState } from "react";
import { ApiError, compareFingerprints } from "../../api/client.js";
import {
  AgreementView,
  RegimeComparison,
} from "./AgreementView.jsx";
import ComparisonMatrix from "./ComparisonMatrix.jsx";
import CorrelationMatrixView from "./CorrelationMatrixView.jsx";
import { ExportCsvButton } from "./ExportButtons.jsx";
import FingerprintSimilarityMatrix from "./FingerprintSimilarityMatrix.jsx";
import NormalizedPerformanceChart from "./NormalizedPerformanceChart.jsx";
import PresetManager from "./PresetManager.jsx";
import RegressionScatterView from "./RegressionScatterView.jsx";
import RollingCorrelationView from "./RollingCorrelationView.jsx";
import NoDatasetGuard from "../NoDatasetGuard.jsx";
import { EmptyState, ErrorState, LoadingState } from "../states/States.jsx";
import { SectionPanel } from "../ui/Ui.jsx";
import { useDatasets } from "../../context/DatasetContext.jsx";
import { useApiData, useParallelApiData } from "../../hooks/useApiData.js";
import {
  buildComparisonRows,
  matrixMetricDefinitions,
} from "../../lib/compareData.js";

const SELECTION_CAP = 10;

const VIEW_TABS = [
  { key: "metrics", label: "Metrics" },
  { key: "cross-market", label: "Cross-market" },
];

export default function CompareWorkspace() {
  return (
    <NoDatasetGuard>
      <CompareInner />
    </NoDatasetGuard>
  );
}

function CompareInner() {
  const { datasets, activeId } = useDatasets();
  const [selectedIds, setSelectedIds] = useState(() =>
    activeId !== null ? [activeId] : [],
  );
  const [view, setView] = useState("metrics");

  const toggle = (id) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id);
      if (prev.length >= SELECTION_CAP) return prev;
      return [...prev, id];
    });
  };

  // Prune selections that no longer exist (deleted datasets).
  const validSelectedIds = selectedIds.filter((id) =>
    datasets.some((dataset) => dataset.id === id),
  );
  const pruned = validSelectedIds.length !== selectedIds.length;
  const selection = validSelectedIds;

  return (
    <div className="stack">
      <header className="page-header">
        <h1 className="page-title">COMPARE</h1>
        <p className="page-subtitle">
          Side-by-side quantitative comparison of two to ten stored datasets.
          All metrics come from the backend analytics engine.
        </p>
      </header>

      <SectionPanel
        title={`Dataset Selection (${selection.length}/${SELECTION_CAP})`}
        subtitle="Choose between 2 and 10 datasets. Fingerprint similarity supports up to 4."
      >
        <div className="control-row">
          {datasets.map((dataset) => (
            <label key={dataset.id} className="control">
              <input
                type="checkbox"
                checked={selection.includes(dataset.id)}
                disabled={
                  !selection.includes(dataset.id) && selection.length >= SELECTION_CAP
                }
                onChange={() => toggle(dataset.id)}
              />
              <span>
                #{dataset.id} Â· {dataset.filename}
              </span>
            </label>
          ))}
        </div>
        {pruned ? (
          <p className="notice" role="status" style={{ marginTop: 10 }}>
            One or more previously selected datasets were deleted and have been
            removed from the comparison.
          </p>
        ) : null}
      </SectionPanel>

      <PresetManager
        selection={selection}
        datasets={datasets}
        onLoadSelection={(ids) => setSelectedIds(ids)}
      />

      <div className="tab-row" role="tablist" aria-label="Compare views">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={view === tab.key}
            className={`chip-btn${view === tab.key ? " active" : ""}`}
            onClick={() => setView(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {selection.length < 2 ? (
        <EmptyState
          title={selection.length === 0 ? "NO DATASETS SELECTED" : "ONE MORE NEEDED"}
          hint={
            selection.length === 0
              ? "Select at least two uploaded datasets above."
              : "Comparisons require at least two datasets. Select one more."
          }
        />
      ) : view === "cross-market" ? (
        <CrossMarketPanel selection={selection} datasets={datasets} />
      ) : (
        <CompareBody selection={selection} datasets={datasets} />
      )}
    </div>
  );
}

function CrossMarketPanel({ selection, datasets }) {
  const basePath = `/datasets/compare/correlation?ids=${selection.join(",")}`;
  const [pairFocus, setPairFocus] = useState(null);

  useEffect(() => {
    // Reset stale pair focus when the selection changes underneath it.
    setPairFocus(null);
  }, [basePath]);

  const effectivePair =
    pairFocus &&
    pairFocus[0] !== pairFocus[1] &&
    selection.includes(pairFocus[0]) &&
    selection.includes(pairFocus[1])
      ? pairFocus
      : selection.length >= 2
        ? [selection[0], selection[1]]
        : null;

  const focusPath =
    effectivePair && effectivePair.length === 2
      ? `${basePath}&pair_focus=${effectivePair.join(",")}`
      : null;

  const baseQuery = useApiData(basePath);
  const focusQuery = useApiData(focusPath ?? "/comparison-presets", {
    enabled: Boolean(focusPath),
  });

  const correlation = focusPath
    ? focusQuery.data ?? baseQuery.data
    : baseQuery.data;
  const loading = baseQuery.loading || (focusPath && focusQuery.loading);
  const error = baseQuery.error ?? (focusPath ? focusQuery.error : null);

  if (error && !correlation) {
    return <ErrorState message={error.message} status={error.status} />;
  }
  if (!correlation) {
    return loading ? (
      <LoadingState label="COMPUTING CROSS-MARKET STATISTICS" />
    ) : (
      <EmptyState title="NO DATA" hint="Unable to compute cross-market statistics." />
    );
  }

  return (
    <>
      {baseQuery.error || focusQuery.error ? (
        <p className="notice notice-error" role="alert">
          A cross-market request failed; showing the last good result.
        </p>
      ) : null}
      <CorrelationMatrixView correlation={correlation} />
      <RollingCorrelationView
        datasets={datasets}
        correlation={correlation}
        pair={effectivePair}
        onPairChange={setPairFocus}
      />
      <RegressionScatterView correlation={correlation} />
    </>
  );
}

function CompareBody({ selection, datasets }) {
  const paths = useMemo(() => {
    const list = [];
    for (const id of selection) {
      list.push(`/datasets/${id}/fingerprint`);
      list.push(`/datasets/${id}/regimes/current`);
      list.push(`/datasets/${id}/intelligence/summary`);
      list.push(`/datasets/${id}/prices`);
    }
    return list;
  }, [selection]);

  const parallel = useParallelApiData(paths);

  const selectedDatasets = selection
    .map((id) => datasets.find((dataset) => dataset.id === id))
    .filter(Boolean);

  const rowValues = useMemo(() => {
    const map = new Map();
    for (const id of selection) map.set(id, null);
    return map;
  }, [selection]);

  if (parallel.loading && parallel.byPath.size === 0) {
    return <LoadingState label="FETCHING COMPARISON DATA" />;
  }

  const failed = Array.from(parallel.errors.entries());
  if (failed.length > 0 && parallel.byPath.size === 0) {
    const first = failed[0][1];
    return <ErrorState message={first.message} status={first.status} />;
  }

  const rowsById = new Map(
    buildComparisonRows(selectedDatasets, parallel.byPath).map((row) => [
      row.dataset.id,
      row,
    ]),
  );
  const metrics = matrixMetricDefinitions();

  return (
    <>
      {failed.length > 0 ? (
        <p className="notice notice-error" role="alert">
          Some per-dataset requests failed:{" "}
          {failed.map(([path, error]) => `${path.split("/")[2]}: ${error.message}`).join("; ")}
        </p>
      ) : null}

      <SectionPanel
        title="Quant Comparison Matrix"
        subtitle="Descriptive metrics only; for most measures higher or lower is not universally better."
        actions={
          <ExportCsvButton
            filename="market-dna-comparison-matrix.csv"
            columns={[
              ...selectedDatasets.map((dataset) => ({
                key: dataset.id,
                label: `#${dataset.id} ${dataset.filename}`,
                value: (row) => {
                  const raw = metricRawValue(metrics.find((m) => m.key === row.key), rowsById.get(dataset.id));
                  return raw ?? "";
                },
              })),
            ]}
            rows={metrics}
          />
        }
      >
        <ComparisonMatrix datasets={selectedDatasets} metrics={metrics} rowValues={rowsById} />
      </SectionPanel>

      <NormalizedPerformanceChart
        entries={selectedDatasets.map((dataset) => ({
          id: dataset.id,
          filename: dataset.filename,
          prices: rowsById.get(dataset.id)?.priceRows ?? [],
          datasetStart: dataset.start_date,
        }))}
      />

      {selection.length <= 4 ? (
        <CompareFingerprintPanel selection={selection} datasets={selectedDatasets} />
      ) : (
        <EmptyState
          title="FINGERPRINT SIMILARITY LIMITED TO 4 DATASETS"
          hint="Deselect a few datasets to use fingerprint-based similarity."
        />
      )}

      <RegimeComparison datasets={selectedDatasets} dataByPath={parallel.byPath} />

      <SectionPanel title="Intelligence Comparison" subtitle="High-level intelligence outputs per dataset.">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">Bias</th>
                <th scope="col">Risk</th>
                <th scope="col">Confidence</th>
                <th scope="col">Analogue agreement</th>
              </tr>
            </thead>
            <tbody>
              {selectedDatasets.map((dataset) => {
                const summary =
                  parallel.byPath.get(`/datasets/${dataset.id}/intelligence/summary`) ?? {};
                return (
                  <tr key={dataset.id}>
                    <td>#{dataset.id} {dataset.filename}</td>
                    <td className="mono">{String(summary.directional_bias ?? "N/A").toUpperCase()}</td>
                    <td className="mono">{String(summary.risk_level ?? "N/A").toUpperCase()}</td>
                    <td className="mono">
                      {summary.confidence === null || summary.confidence === undefined
                        ? "N/A"
                        : `${Math.round(summary.confidence * 100)}%`}
                    </td>
                    <td className="mono">{String(summary.analogue_agreement ?? "N/A").toUpperCase()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionPanel>

      <AgreementView datasets={selectedDatasets} rowValues={rowsById} />
    </>
  );
}

function metricRawValue(metric, row) {
  if (!metric || !row) return undefined;
  if (metric.raw) return metric.raw(row);
  return metric.value(row);
}

function CompareFingerprintPanel({ selection, datasets }) {
  const idsParam = selection.join(",");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setResult(null);
    compareFingerprints(selection)
      .then((payload) => {
        if (!cancelled) setResult(payload);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(
            caught instanceof ApiError
              ? caught
              : new Error("Fingerprint comparison request failed."),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [idsParam]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return <ErrorState message={error.message} status={error.status} />;
  }
  if (!result) {
    return <LoadingState label="COMPARING FINGERPRINTS" />;
  }
  return <FingerprintSimilarityMatrix comparison={result} datasets={datasets} />;
}

