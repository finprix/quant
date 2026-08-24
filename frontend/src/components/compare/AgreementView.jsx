import { useMemo } from "react";
import { SectionPanel } from "../ui/Ui.jsx";
import { formatConfidence, formatInteger, formatPercent } from "../../lib/format.js";

/**
 * Compact descriptive view of which datasets currently share identical
 * state values. Grouping only; no recommendations are implied.
 */
export function AgreementView({ datasets, rowValues }) {
  const FIELDS = [
    ["directional_bias", "Directional bias"],
    ["risk_level", "Risk level"],
    ["trend_state", "Trend state"],
    ["volatility_state", "Volatility state"],
    ["analogue_agreement", "Analogue agreement"],
  ];

  const groups = useMemo(() => {
    return FIELDS.map(([field, label]) => {
      const byValue = new Map();
      for (const dataset of datasets) {
        const value = String(rowValues.get(dataset.id)?.summary?.[field] ?? "N/A");
        if (!byValue.has(value)) byValue.set(value, []);
        byValue.get(value).push(dataset);
      }
      return { field, label, groups: Array.from(byValue.entries()) };
    });
  }, [datasets, rowValues]);

  return (
    <SectionPanel title="State Agreement" subtitle="Which datasets currently share identical state values. Descriptive grouping only.">
      <div className="stack" style={{ gap: 10 }}>
        {groups.map(({ field, label, groups: valueGroups }) => (
          <div key={field} className="agreement-row">
            <span className="evidence-name">{label}</span>
            <div className="tag-list">
              {valueGroups.map(([value, members]) => (
                <span
                  key={value}
                  className={`tag${members.length > 1 ? " tag-shared" : ""}`}
                  title={`${value}: ${members.map((m) => `#${m.id}`).join(", ")}`}
                >
                  {members.map((m) => `#${m.id}`).join(",")}
                  {" · "}
                  {String(value).toUpperCase()}
                  {members.length > 1 ? ` (${members.length})` : ""}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="hint-text">
        Matching labels describe similar recent statistical behaviour; they do not
        imply the assets are identical or that their futures will resemble each other.
      </p>
    </SectionPanel>
  );
}

/**
 * Regime comparison across datasets using the lightweight /regimes/current
 * endpoint. All values are historical clustering outputs.
 */
export function RegimeComparison({ datasets, dataByPath }) {
  return (
    <SectionPanel title="Regime Comparison" subtitle="Current regime assignment per dataset from independent discovery runs.">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Dataset</th>
              <th scope="col">Regime label</th>
              <th scope="col">ID</th>
              <th scope="col">Confidence</th>
              <th scope="col">Hist. frequency</th>
              <th scope="col">Streak</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((dataset) => {
              const current =
                dataByPath.get(`/datasets/${dataset.id}/regimes/current`)?.current_regime ?? {};
              return (
                <tr key={dataset.id}>
                  <td>#{dataset.id} {dataset.filename}</td>
                  <td>{current.label ?? "N/A"}</td>
                  <td className="mono">{current.regime_id ?? "N/A"}</td>
                  <td className="mono">{formatConfidence(current.confidence)}</td>
                  <td className="mono">{formatPercent(current.profile_summary?.percentage_of_windows, { decimals: 1 })}</td>
                  <td className="mono">
                    {current.duration_windows !== undefined && current.duration_windows !== null
                      ? `${formatInteger(current.duration_windows)} win (~${formatInteger(current.approx_duration_trading_days)}d)`
                      : "N/A"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint-text">
        Each regime model is discovered independently per dataset with unsupervised
        clustering. Identical or similar labels do not mean the datasets share a market.
      </p>
    </SectionPanel>
  );
}
