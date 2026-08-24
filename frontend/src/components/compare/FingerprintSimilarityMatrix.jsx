import { useMemo, useState } from "react";
import { SectionPanel } from "../ui/Ui.jsx";
import { formatNumber } from "../../lib/format.js";

const METRICS = [
  { key: "similarity", label: "Similarity score" },
  { key: "standardized", label: "Standardized distance" },
  { key: "euclidean", label: "Euclidean distance" },
];

/**
 * Symmetric pairwise fingerprint comparison heatmap. Lower triangle shaded,
 * diagonal fixed at identity (similarity 1 / distance 0).
 */
export default function FingerprintSimilarityMatrix({ comparison, datasets }) {
  const [metric, setMetric] = useState("similarity");

  const ids = useMemo(() => comparison?.matrix?.ids ?? [], [comparison]);
  const matrix = comparison?.matrix?.[metric];

  if (!ids.length || !matrix) {
    return (
      <SectionPanel title="Fingerprint Distance">
        <p className="table-empty">Comparison payload unavailable.</p>
      </SectionPanel>
    );
  }

  const labelOf = (id) => {
    const dataset = datasets.find((entry) => entry.id === id);
    return `#${id} ${dataset ? dataset.filename : ""}`.trim();
  };

  const maxValue =
    metric === "similarity"
      ? 1
      : Math.max(...matrix.flat().filter((v) => Number.isFinite(v)), 1e-9);

  return (
    <SectionPanel
      title="Fingerprint Distance"
      subtitle={
        metric === "similarity"
          ? "Pairwise scale-free fingerprint similarity; 1.0 means statistically indistinguishable full-history fingerprints."
          : "Pairwise distances between full-history scale-free fingerprint vectors."
      }
      actions={
        <div className="control-row print-hidden" role="group" aria-label="Distance metric">
          {METRICS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`btn${metric === option.key ? " is-active" : ""}`}
              onClick={() => setMetric(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="table-scroll">
        <table className="data-table transition-table">
          <thead>
            <tr>
              <th scope="col">Dataset</th>
              {ids.map((id) => (
                <th key={id} scope="col">{`#${id}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ids.map((rowId, rowIndex) => (
              <tr key={rowId}>
                <td title={labelOf(rowId)}>{labelOf(rowId)}</td>
                {ids.map((colId, colIndex) => {
                  const value = matrix[rowIndex][colIndex];
                  const intensity =
                    metric === "similarity" ? value : value / (maxValue || 1);
                  return (
                    <td
                      key={colId}
                      className="transition-cell"
                      style={{
                        background:
                          rowIndex === colId
                            ? "var(--panel-deep)"
                            : `rgba(86, 184, 165, ${Math.min(0.6, Math.max(0, intensity) * 0.85)})`,
                      }}
                      title={`${labelOf(rowId)} vs ${labelOf(colId)}: ${formatNumber(value, 4)}`}
                    >
                      {formatNumber(value, metric === "similarity" ? 3 : 3)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint-text">{comparison?.reference?.method}</p>
      <p className="hint-text">
        Based on the same {comparison?.reference?.total_features ?? "?"}-feature scale-free
        vectors used by the analogue engine, standardized against{" "}
        {formatNumber(comparison?.reference?.reference_windows, 0)} pooled sliding windows.
        Similarity 0.5 corresponds to roughly one pooled standard deviation of separation
        per feature. These are descriptive statistics of historical behaviour.
      </p>
    </SectionPanel>
  );
}
