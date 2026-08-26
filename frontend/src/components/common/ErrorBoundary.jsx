import { Component } from "react";

/**
 * Route-level crash guard. A rendering error inside one page must never
 * blank the whole terminal — only that route shows a contextual failure
 * with a recovery action.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="state-block" role="alert">
        <p className="state-title">VIEW CRASHED</p>
        <p className="state-hint">
          {error?.message
            ? `This view failed to render: ${error.message}.`
            : "This view failed to render."}{" "}
          The rest of FINPRIX remains available. If this started after an
          update, a full reload picks up the latest build.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button
            type="button"
            className="btn primary"
            onClick={() => this.setState({ error: null })}
          >
            Reload View
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => window.location.reload()}
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
