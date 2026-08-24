/**
 * Contextual state blocks used across all pages.
 * Every failure must be explicit and recoverable — never a blank area.
 */

import { useState } from "react";
import useSymbolImport from "../../hooks/useSymbolImport.js";

export function LoadingState({ label = "LOADING" }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <div className="state-spinner" aria-hidden="true" />
      <span className="metric-label">{label}</span>
    </div>
  );
}

export function SkeletonState({ lines = 4 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          className="skeleton-line"
          key={i}
          style={{ width: `${92 - i * 14}%` }}
        />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry, status, title = "REQUEST FAILED", hint }) {
  return (
    <div className="state-block" role="alert">
      <p className="state-title">{title}</p>
      {status ? (
        <span className="metric-label">HTTP STATUS: {status}</span>
      ) : null}
      <p className="state-hint">
        {hint || message || "The backend returned an error for this request."}
      </p>
      {onRetry ? (
        <button type="button" className="btn primary small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, hint, action }) {
  return (
    <div className="state-block">
      <p className="state-title">{title}</p>
      {hint ? <p className="state-hint">{hint}</p> : null}
      {action}
    </div>
  );
}

export function NoDatasetState() {
  // Dataset-independent by design: offer one-click live analysis instead of
  // a dead end. Picking from the context bar above still works too.
  const [symbol, setSymbol] = useState("");
  const { launch, phase, stage, error } = useSymbolImport();
  const importing = phase === "importing";

  const submit = (event) => {
    event.preventDefault();
    if (symbol.trim()) launch(symbol.trim());
  };

  return (
    <div className="state-block">
      <p className="state-title">NO DATASET SELECTED</p>
      <p className="state-hint">
        Pick a dataset in the context bar above — or analyze any supported
        symbol live right now:
      </p>
      <form className="live-launch-form" onSubmit={submit}>
        <input
          className="ai-input"
          value={symbol}
          placeholder="e.g. AAPL, ^GSPC, BTC-USD"
          disabled={importing}
          maxLength={24}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
        <button
          type="submit"
          className="btn accent small"
          disabled={importing || !symbol.trim()}
        >
          {importing ? stage || "IMPORTING…" : "IMPORT & ANALYZE"}
        </button>
      </form>
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}

export default { LoadingState, ErrorState, EmptyState, NoDatasetState, SkeletonState };
