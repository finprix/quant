import { request } from "./client.js";

export function getDbStatus() {
  return request("/database/status");
}

export function getDbStats() {
  return request("/database/stats");
}

export function getDbTables() {
  return request("/database/tables");
}

export function getDbSchema(table) {
  return request(`/database/tables/${table}/schema`);
}

export function getDbRows(table, params = {}) {
  return request(`/database/tables/${table}`, { params });
}

export function getDatasetStorage(datasetId) {
  return request(`/database/datasets/${datasetId}/storage`);
}

export function runIntegrityCheck() {
  return request("/database/integrity", { method: "POST" });
}

export function runRawQuery(sql) {
  return request("/database/query", {
    method: "POST",
    body: { sql },
  });
}
