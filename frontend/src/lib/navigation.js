/**
 * Central route map (v0.19.0 product hierarchy).
 *
 * DISCOVER  -> /            (Overview command center), /markets
 * ANALYZE   -> /analysis/{view}   (one shared workspace, five tabs)
 * RESEARCH  -> /compare, /ai, /report
 * DATA      -> /datasets, /database
 *
 * Page ownership: every feature lives in exactly one place. Markets owns
 * discovery; the analysis shell owns per-asset understanding; Overview
 * only summarizes and links deeper.
 */

export const ANALYSIS_VIEWS = [
  { key: "fingerprint", label: "Fingerprint" },
  { key: "analogues", label: "Analogues" },
  { key: "regimes", label: "Regimes" },
  { key: "intelligence", label: "Intelligence" },
  { key: "heatmaps", label: "Heatmaps" },
];

export const analysisPath = (key, datasetId) =>
  `/analysis/${key}${datasetId ? `?dataset=${datasetId}` : ""}`;

export const fingerprintPath = (datasetId) => analysisPath("fingerprint", datasetId);

/** Extract the tracked symbol from an imported dataset filename. */
export function symbolFromFilename(filename) {
  const match = String(filename || "").match(/^([A-Za-z0-9.\-^=]+)_/);
  return match ? match[1].toUpperCase() : null;
}
