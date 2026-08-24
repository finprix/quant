import { request } from "./client.js";

export function compareFingerprints(datasetIds) {
  return request("/datasets/compare/fingerprints", {
    params: { ids: datasetIds.join(",") },
  });
}

export function getCorrelation(datasetIds, { pairFocus } = {}) {
  return request("/datasets/compare/correlation", {
    params: {
      ids: datasetIds.join(","),
      pair_focus:
        pairFocus && pairFocus.length === 2
          ? pairFocus.join(",")
          : undefined,
    },
  });
}

export function getPresets() {
  return request("/comparison-presets");
}

export function createPreset({ name, datasetIds }) {
  return request("/comparison-presets", {
    method: "POST",
    body: { name, dataset_ids: datasetIds },
  });
}

export function updatePreset(presetId, { name, datasetIds } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (datasetIds !== undefined) body.dataset_ids = datasetIds;
  return request(`/comparison-presets/${presetId}`, { method: "PUT", body });
}

export function deletePreset(presetId) {
  return request(`/comparison-presets/${presetId}`, { method: "DELETE" });
}
