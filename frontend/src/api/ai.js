import { request } from "./client.js";

export function getAiStatus() {
  return request("/ai/status");
}

export function queryAi({ question, datasetId }) {
  return request("/ai/query", {
    method: "POST",
    body: { question, dataset_id: datasetId },
  });
}
