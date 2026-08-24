import { useMemo, useState } from "react";
import { SectionPanel } from "../ui/Ui.jsx";
import {
  formatNumber,
  formatInteger,
  NA,
} from "../../lib/format.js";

const MATRIX_TYPES = [
  { key: "pearson", label: "Pearson", kind: "correlation" },
  { key: "spearman", label: "Spearman", kind: "correlation" },
  { key: "downside", label: "Downside", kind: "correlation" },
  { key: "upside", label: "Upside", kind: "correlation" },
  { key: "covariance", label: "Covariance", kind: "scale" },
  { key: "overlap_count", label: "Overlap days", kind: "count" },
];

function correlationColor(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "transparent";
  }
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped >= 0) {
    return `rgba(52, 211, 153, ${0.08 + clamped * 0.55})`;
  }
  return `rgba(248, 113, 113, ${0.08 + Math.abs(clamped) * 0.55})`;
}

function scaleColor(value, maxAbs) {
  if (value === null || value === undefined || !Number.isFinite(value) || maxAbs === 0) {
    return "transparent";
  }
  const intensity = 0.06 + (Math.abs(value) / maxAbs) * 0.6;
  return value >= 0
    ? `rgba(96, 165, 250, ${intensity})`
    : `rgba(251, 146, 60, ${intensity})`;
}

function cellText(value, kind) {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  if (kind === "count") return formatInteger(value);
  if (kind === "scale") return value.toExponential(2);
  return formatNumber(value, 2);
}

export default function CorrelationMatrixView({ correlation }) {
  const [matrixType, setMatrixType] = useState("pearson");
  const active = MATRIX_TYPES.find((entry) => entry.key === matrixType);

  const matrices = correlation?.matrices ?? {};
  const ids = matrices.ids ?? [];
  const metadata = correlation?.metadata ?? {};

  const maxAbsCovariance = useMemo(() => {
    let max = 0;
    for (const row of matrices.covariance ?? []) {
      for (const value of row) {
        if (Number.isFinite(value)) max = Math.max(max, Math.abs(value));
      }
    }
    return max;
  }, [matrices]);

  const maxOverlap = useMemo(() => {
    let max = 1;
    for (const row of matrices.overlap_count ?? []) {
      for (const value of row) {
        if (Number.isFinite(value)) max = Math.max(max, value);
      }
    }
    return max;
  }, [matrices]);

  const overlap = correlation?.overlap ?? {};

  return (
    <SectionPanel
      title="Correlation Matrix"
      subtitle="Daily-return co-movement over overlapping trading dates. Correlation describes history; it does not imply causation."
      actions={
        <div className="control-row" role="tablist" aria-label="Matrix type">
          {MATRIX_TYPES.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`chip-btn${matrixType === entry.key ? " active" : ""}`}
              onClick={() => setMatrixType(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
    >
      <p className="mono muted small">
        Overlap window: {overlap.start_date ?? NA} → {overlap.end_date ?? NA} ·
        minimum pairwise overlap: {formatInteger(overlap.minimum_pairwise_overlap)}{" "}
        return observations
      </p>

      <div className="table-scroll heatmap-scroll">
        <table className="data-table heatmap-table">
          <thead>
            <tr>
              <th scope="col" aria-label="Dataset" />
              {ids.map((id) => (
                <th scope="col" key={id} className="mono">
                  #{id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ids.map((rowId, rowIndex) => (
              <tr key={rowId}>
                <th scope="row" className="mono heatmap-row-label">
                  #{rowId} {metadata[String(rowId)]?.filename ?? ""}
                </th>
                {(matrices[matrixType] ?? [])[rowIndex]?.map((value, colIndex) => (
                  <td
                    key={colIndex}
                    className="mono heatmap-cell"
                    style={{
                      background:
                        active.kind === "correlation"
                          ? correlationColor(value)
                          : scaleColor(
                              value,
                              active.kind === "count" ? maxOverlap : maxAbsCovariance,
                            ),
                    }}
                    title={
                      metadata[String(ids[colIndex])]?.filename ?? ""
                    }
                  >
                    {cellText(value, active.kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active?.kind === "correlation" ? (
        <div className="heatmap-legend mono small">
          <span>-1.00</span>
          <span className="heatmap-legend-gradient" aria-hidden="true" />
          <span>+1.00</span>
          <span className="muted">red = moves apart · green = moves together</span>
        </div>
      ) : null}

      <p className="disclaimer-text">
        {correlation?.disclaimer ??
          "Cross-market statistics describe historical co-movement only."}
      </p>
    </SectionPanel>
  );
}
