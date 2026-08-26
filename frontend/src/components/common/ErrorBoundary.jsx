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
          This view failed to render{error?.message ? `: ${error.message}` : ""}.
          The rest of FINPRIX remains available.
        </p>
        <button
          type="button"
          className="btn primary"
          onClick={() => this.setState({ error: null })}
        >
          Reload View
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
