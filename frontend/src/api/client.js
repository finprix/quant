// Same-origin by default: the Vite dev server proxies /api/* to the backend,
// keeping the session cookie first-party. Set VITE_API_BASE_URL for
// split-host deployments (e.g. "https://api.example.com").
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export async function request(path, { method = "GET", params, body, formData } = {}) {
  let url = `${API_BASE_URL}${path}`;
  if (params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        query.set(key, String(value));
      }
    }
    const qs = query.toString();
    if (qs) url += `?${qs}`;
  }

  const options = { method, headers: {}, credentials: "include" };
  if (formData) {
    options.body = formData;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (networkError) {
    throw new ApiError(
      "Backend unreachable. Verify the QUANT VECTOR API is running.",
      0,
      null,
    );
  }

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail =
      (payload && (payload.detail || payload.message)) ||
      `Request failed with status ${response.status}`;
    throw new ApiError(
      typeof detail === "string" ? detail : JSON.stringify(detail),
      response.status,
      payload,
    );
  }

  return payload;
}

export function checkHealth() {
  return request("/health");
}

export function uploadDataset(file) {
  const formData = new FormData();
  formData.append("file", file);
  return request("/upload", { method: "POST", formData });
}

export function getDatasets() {
  return request("/datasets");
}

export function getDataset(datasetId) {
  return request(`/datasets/${datasetId}`);
}

export function deleteDataset(datasetId) {
  return request(`/datasets/${datasetId}`, { method: "DELETE" });
}

export function getPrices(datasetId) {
  return request(`/datasets/${datasetId}/prices`);
}

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

/* ------------------------------ auth ------------------------------ */

export function getAuthSession() {
  return request("/auth/session");
}

export function loginDeveloper(pin) {
  return request("/auth/login", { method: "POST", body: { pin } });
}

export function logoutDeveloper() {
  return request("/auth/logout", { method: "POST" });
}
