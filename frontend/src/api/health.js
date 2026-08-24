import { request } from "./client.js";

export function checkHealth() {
  return request("/health");
}
