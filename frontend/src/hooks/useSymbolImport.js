import { useCallback, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { request } from "../api/client.js";

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * One-click live analysis: import a symbol through the staged ingestion
 * pipeline and land on an analysis page with the new dataset selected.
 *
 * Works regardless of whether any dataset exists yet, which keeps every
 * quant page fully functional before any CSV has been uploaded.
 */
export default function useSymbolImport({ onComplete } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [phase, setPhase] = useState("idle"); // idle | importing | done
  const [stage, setStage] = useState(null);
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  const launch = useCallback(
    async (rawSymbol, overrides = {}) => {
      const symbol = String(rawSymbol || "").trim().toUpperCase();
      if (!symbol || phase === "importing") return null;
      setPhase("importing");
      setStage("FETCHING");
      setError(null);

      const end = new Date().toISOString().slice(0, 10);
      const start = isoDaysAgo(overrides.days ?? 420);

      try {
        const started = await request("/market/import", {
          method: "POST",
          body: {
            symbol,
            start_date: overrides.start_date ?? start,
            end_date: overrides.end_date ?? end,
            interval: "1d",
          },
        });
        const jobId = started.job_id;
        let finalStatus = null;
        for (let i = 0; i < 90; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 1200));
          const status = await request(`/market/import/status/${jobId}`);
          setStage(status.stage || status.status);
          if (status.status === "COMPLETE" || status.status === "FAILED") {
            finalStatus = status;
            break;
          }
        }
        if (!mounted.current) return null;
        if (finalStatus?.status !== "COMPLETE") {
          throw new Error(
            finalStatus?.error ||
              "Import did not finish in time. Try again or import manually from Markets.",
          );
        }
        const datasetId = finalStatus.result?.dataset_id;
        setPhase("done");
        if (onComplete) {
          onComplete(datasetId, finalStatus.result);
        } else {
          navigate(
            `${location.pathname}?dataset=${datasetId}`,
            { replace: false },
          );
        }
        return datasetId;
      } catch (err) {
        if (mounted.current) {
          setPhase("idle");
          const msg = err?.message || String(err);
          setError(
            msg.includes("DEVELOPER ACCESS REQUIRED") || err?.status === 401
              ? "Importing live symbols requires a developer session. Pick a stored dataset above instead."
              : msg,
          );
        }
        return null;
      }
    },
    [navigate, location.pathname, onComplete, phase],
  );

  return { launch, phase, stage, error };
}
