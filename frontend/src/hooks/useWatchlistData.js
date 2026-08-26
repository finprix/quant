import { useCallback, useEffect, useRef, useState } from "react";
import { getWatchlist } from "../api/watchlist.js";
import { request } from "../api/client.js";
import { useDatasets } from "../context/DatasetContext.jsx";
import { symbolFromFilename } from "../lib/navigation.js";

/**
 * Single source of tracked-symbol rows for DISCOVER surfaces
 * (Markets discovery table + Overview command center watchlist).
 *
 * Enriches every row with:
 *   stored          – matching dataset from the library (or null)
 *   regime_label    – latest persisted regime label (universe merge)
 *   evidence_bias   – freshest stored intelligence bias score
 *   last_analysis_ts– when this dataset was last opened (local recents)
 *
 * `withUniverse` pulls /market/overview for the quant columns; without it
 * the hook stays quote-only (cheaper).
 */
export default function useWatchlistData({ withUniverse = false, pollMs = 60_000 } = {}) {
  const { datasets, recentAnalyses } = useDatasets();
  const [rows, setRows] = useState(null);
  const [gainers, setGainers] = useState([]);
  const [losers, setLosers] = useState([]);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    const payload = await getWatchlist();
    const list = payload.symbols || [];

    const dsBySymbol = new Map();
    for (const d of datasets) {
      const s = symbolFromFilename(d.filename);
      if (s && !dsBySymbol.has(s)) dsBySymbol.set(s, d);
    }

    const uniByDatasetId = new Map();
    if (withUniverse) {
      try {
        const overview = await request("/market/overview");
        for (const u of overview.instruments || []) {
          uniByDatasetId.set(u.dataset_id, u);
        }
      } catch {
        /* quant columns degrade to N/A — quotes still render */
      }
    }

    const lastTs = new Map(recentAnalyses.map((r) => [r.id, r.ts]));
    for (const row of list) {
      const stored = dsBySymbol.get(row.symbol) || null;
      const uni = stored ? uniByDatasetId.get(stored.id) : null;
      row.stored = stored;
      row.regime_label = uni?.regime_label ?? null;
      row.evidence_bias =
        typeof uni?.evidence_bias === "number" ? uni.evidence_bias : null;
      row.last_analysis_ts = stored ? lastTs.get(stored.id) ?? null : null;
      if (row.quote && row.quote.dataset_id == null && stored) {
        row.quote.dataset_id = stored.id;
      }
    }

    setRows(list);
    setGainers(payload.gainers || []);
    setLosers(payload.losers || []);
    setError(null);
    setUpdatedAt(new Date());
    return payload;
  }, [datasets, recentAnalyses, withUniverse]);

  useEffect(() => {
    let alive = true;
    load().catch((err) => {
      if (alive) setError(err.message || String(err));
    });
    timerRef.current = setInterval(() => {
      load().catch(() => {});
    }, pollMs);
    return () => {
      alive = false;
      clearInterval(timerRef.current);
    };
  }, [load, pollMs]);

  return { rows, gainers, losers, error, updatedAt, reload: load };
}
