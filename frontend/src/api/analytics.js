import { request } from "./client.js";

export function getFingerprint(datasetId) {
  return request(`/datasets/${datasetId}/fingerprint`);
}

export function getAnalogues(datasetId, { lookback, topN } = {}) {
  return request(`/datasets/${datasetId}/analogues`, {
    params: { lookback, top_n: topN },
  });
}

export function getRegimes(datasetId, { windowSize, k } = {}) {
  return request(`/datasets/${datasetId}/regimes`, {
    params: { window_size: windowSize, k },
  });
}

export function getCurrentRegime(datasetId, { windowSize } = {}) {
  return request(`/datasets/${datasetId}/regimes/current`, {
    params: { window_size: windowSize },
  });
}

export function getIntelligence(
  datasetId,
  { lookback, topN, windowSize, k } = {},
) {
  return request(`/datasets/${datasetId}/intelligence`, {
    params: {
      lookback,
      top_n: topN,
      window_size: windowSize,
      k,
    },
  });
}

export function getIntelligenceSummary(
  datasetId,
  { lookback, topN, windowSize, k } = {},
) {
  return request(`/datasets/${datasetId}/intelligence/summary`, {
    params: {
      lookback,
      top_n: topN,
      window_size: windowSize,
      k,
    },
  });
}
