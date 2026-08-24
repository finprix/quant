export const NA = "N/A";

function isBlank(value) {
  return value === null || value === undefined || Number.isNaN(value);
}

export function formatNumber(value, decimals = 2) {
  if (isBlank(value)) return NA;
  if (!Number.isFinite(value)) return NA;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPrice(value) {
  return formatNumber(value, 2);
}

export function formatPercent(value, { signed = false, decimals = 2 } = {}) {
  if (isBlank(value) || !Number.isFinite(value)) return NA;
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(decimals)}%`;
}

export function formatSignedPercent(value, decimals = 2) {
  return formatPercent(value, { signed: true, decimals });
}

export function formatConfidence(value) {
  if (isBlank(value) || !Number.isFinite(value)) return NA;
  return `${Math.round(value * 100)}%`;
}

export function formatRatio(value) {
  if (isBlank(value) || !Number.isFinite(value)) return NA;
  return `${value.toFixed(3)}x`;
}

export function formatDate(value) {
  if (isBlank(value) || value === "") return NA;
  return String(value).slice(0, 10);
}

export function formatDateRange(start, end) {
  if (isBlank(start) && isBlank(end)) return NA;
  return `${formatDate(start)} → ${formatDate(end)}`;
}

export function formatInteger(value) {
  if (isBlank(value)) return NA;
  return Number(value).toLocaleString("en-US");
}

export function formatDateTime(value) {
  if (isBlank(value) || value === "") return NA;
  const parsed = new Date(String(value).includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const BULLISH_TERMS = ["bullish", "positive"];
const BEARISH_TERMS = ["bearish", "negative"];

export function toneForValue(term) {
  const lower = String(term ?? "").toLowerCase();
  if (BULLISH_TERMS.some((t) => lower.includes(t))) return "up";
  if (BEARISH_TERMS.some((t) => lower.includes(t))) return "down";
  return "flat";
}

export function toneForScore(score) {
  if (isBlank(score) || !Number.isFinite(score)) return "flat";
  if (score > 0.15) return "up";
  if (score < -0.15) return "down";
  return "flat";
}
