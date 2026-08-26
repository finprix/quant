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

/** Compact relative time: "just now", "4m ago", "3h ago", "12d ago". */
export function formatRelativeTime(value) {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 32) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
