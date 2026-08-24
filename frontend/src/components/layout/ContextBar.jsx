import { useEffect, useState } from "react";
import { useDatasets } from "../../context/DatasetContext.jsx";
import { useApiData, invalidateCache } from "../../hooks/useApiData.js";
import { checkHealth } from "../../api/health.js";

const HEALTH_POLL_MS = 20_000;

function formatRange(dataset) {
  if (!dataset?.start_date || !dataset?.end_date) return "—";
  return `${dataset.start_date} → ${dataset.end_date}`;
}

export default function ContextBar() {
  const { datasets, datasetsLoading, activeId, activeDataset, selectDataset } =
    useDatasets();
  const [apiUp, setApiUp] = useState(null);

  const regimePath = activeId
    ? `/datasets/${activeId}/regimes/current?window_size=60`
    : null;
  const { data: regimeData } = useApiData(regimePath);
  const regime = regimeData?.available ? regimeData.current_regime : null;

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        await checkHealth();
        if (!cancelled) setApiUp(true);
      } catch {
        if (!cancelled) setApiUp(false);
      }
    };
    poll();
    const timer = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const onSelectorChange = (event) => {
    const value = event.target.value;
    if (value === "") return;
    selectDataset(Number(value));
  };

  return (
    <div className="ctx-bar" role="status">
      <div className="ctx-item">
        <span className="ctx-label">Dataset</span>
        <select
          className="dataset-select"
          value={activeId ?? ""}
          onChange={onSelectorChange}
          disabled={datasetsLoading || datasets.length === 0}
          aria-label="Active dataset"
        >
          {datasets.length === 0 ? (
            <option value="">NO DATASETS</option>
          ) : (
            datasets.map((d) => (
              <option key={d.id} value={d.id}>
                #{d.id} · {d.filename} · {d.row_count}r
              </option>
            ))
          )}
        </select>
      </div>
      <div className="ctx-item">
        <span className="ctx-label">Date Range</span>
        <span className="ctx-value">{formatRange(activeDataset)}</span>
      </div>
      <div className="ctx-item">
        <span className="ctx-label">Last Close</span>
        <span className="ctx-value biscuit">
          {activeDataset?.latest_close != null
            ? activeDataset.latest_close.toFixed(2)
            : "—"}
        </span>
      </div>
      <div className="ctx-item">
        <span className="ctx-label">Rows</span>
        <span className="ctx-value">
          {activeDataset?.row_count?.toLocaleString() ?? "—"}
        </span>
      </div>
      <div className="ctx-item">
        <span className="ctx-label">Current Regime</span>
        <span className="ctx-value accent" title={regime?.label ?? ""}>
          {regime
            ? `R${String(regime.regime_id + 1).padStart(2, "0")} · ${
                regime.label ?? ""
              }`
            : "UNAVAILABLE"}
        </span>
      </div>
      <div className="ctx-item">
        <span className="ctx-label">API</span>
        <span
          className={`api-dot${apiUp === null ? "" : apiUp ? " live" : " down"}`}
          aria-hidden="true"
        />
        <span className="ctx-value">
          {apiUp === null ? "…" : apiUp ? "ONLINE" : "OFFLINE"}
        </span>
      </div>
    </div>
  );
}

export function refreshActiveDatasetData() {
  invalidateCache();
}
