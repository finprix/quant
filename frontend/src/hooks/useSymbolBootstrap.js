import { useEffect, useRef, useState } from "react";
import { getAssetBootstrap } from "../api/web.js";

const STAGES = [
  "Resolving instrument",
  "Fetching market history",
  "Normalizing candles",
  "Preparing Finprix analysis",
];

/**
 * Symbol-first bootstrap: turn a public ticker into an analysis-ready
 * cached dataset. Reports staged progress so the UI never looks frozen.
 */
export default function useSymbolBootstrap(symbol, refreshKey = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stageIdx, setStageIdx] = useState(0);
  const stageTimer = useRef(null);

  useEffect(() => {
    const key = String(symbol || "").trim().toUpperCase();
    if (!key) {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    let alive = true;
    setLoading(true);
    setError(null);
    setStageIdx(0);
    clearInterval(stageTimer.current);
    stageTimer.current = setInterval(() => {
      if (alive) setStageIdx((i) => Math.min(i + 1, STAGES.length - 1));
    }, 1600);

    getAssetBootstrap(key)
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || String(err));
        setLoading(false);
      });

    return () => {
      alive = false;
      clearInterval(stageTimer.current);
    };
  }, [symbol, refreshKey]);

  return {
    data,
    error,
    loading,
    stage: STAGES[stageIdx],
  };
}
