import { useDatasets } from "../../context/DatasetContext.jsx";
import { symbolFromFilename } from "../../lib/navigation.js";
import { formatRelativeTime } from "../../lib/format.js";
import useLiveQuote from "../../hooks/useLiveQuote.js";

/**
 * Global asset context bar (v0.19.0).
 *
 * The single source of "what am I looking at" across the whole analysis
 * workspace: symbol, dataset identity, row count, freshness, live quote.
 * Rendered once by AnalysisLayout — individual analysis views must not
 * duplicate this information.
 */
export default function AssetContextBar() {
  const { activeId, activeDataset, datasets, datasetsLoading, selectDataset } =
    useDatasets();

  const symbol = symbolFromFilename(activeDataset?.filename);
  const quote = useLiveQuote(symbol);

  if (!activeDataset) {
    return (
      <div className="asset-bar empty" role="status">
        <span className="asset-symbol mono">—</span>
        <span className="fineprint">
          No dataset selected — choose one below or import a symbol to begin.
        </span>
      </div>
    );
  }

  const changePct = quote?.change_percent;

  return (
    <div className="asset-bar" role="status">
      <div className="asset-identity">
        <span className="asset-symbol mono">{symbol ?? "?"}</span>
        <div className="asset-meta">
          <span className="asset-dataset">
            {activeDataset.filename}
            <span className="fineprint"> #{activeId}</span>
          </span>
          <span className="asset-sub fineprint">
            Rows {activeDataset.row_count?.toLocaleString() ?? "—"} · Updated{" "}
            {formatRelativeTime(activeDataset.end_date)} ·{" "}
            {activeDataset.start_date} → {activeDataset.end_date}
          </span>
        </div>
      </div>

      <div className="asset-live mono">
        {quote?.price != null ? (
          <>
            <span className="ctx-label">LIVE</span>
            <span className="asset-price">{quote.price}</span>
            <span
              className={`tick-pct ${changePct >= 0 ? "pos" : "neg"}`}
            >
              {changePct >= 0 ? "+" : ""}
              {changePct}%
            </span>
          </>
        ) : (
          <span className="fineprint">live quote unavailable</span>
        )}
      </div>

      <label className="asset-switch">
        <span className="ctx-label">Change</span>
        <select
          className="dataset-select"
          value={activeId ?? ""}
          disabled={datasetsLoading || datasets.length === 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) selectDataset(v);
          }}
          aria-label="Switch analyzed dataset"
        >
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              #{d.id} · {d.filename}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
