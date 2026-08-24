import { request } from "./client.js";

export function searchMarket(query, provider) {
  return request("/market/search", { params: { q: query, provider } });
}

export function startMarketImport(payload) {
  return request("/market/import", { method: "POST", body: payload });
}

export function getImportStatus(jobId) {
  return request(`/market/import/status/${jobId}`);
}

export function updateMarketDataset(datasetId) {
  return request(`/market/update/${datasetId}`, { method: "POST" });
}

export function getMarketOverview() {
  return request("/market/overview");
}
