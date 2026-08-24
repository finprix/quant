import { request } from "./client.js";

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
