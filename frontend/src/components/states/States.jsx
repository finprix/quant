/**
 * Contextual state blocks used across all pages.
 * Every failure must be explicit and recoverable — never a blank area.
 */

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
  return (
    <EmptyState
      title="NO DATASET SELECTED"
      hint="Upload a CSV on the Datasets page or pick a dataset in the context bar above to begin analysis."
    />
  );
}

export default { LoadingState, ErrorState, EmptyState, NoDatasetState, SkeletonState };
