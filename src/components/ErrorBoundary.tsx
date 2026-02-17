import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary — catches render-time errors and shows a recovery UI
 * instead of white-screening the entire app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Branch ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleHardReset = () => {
    // Clear potentially corrupted localStorage and reload
    const keysToKeep = ['branch_playground_encrypted_keys']; // preserve encrypted keys
    const preserved: Record<string, string> = {};
    for (const key of keysToKeep) {
      const val = localStorage.getItem(key);
      if (val) preserved[key] = val;
    }
    localStorage.clear();
    for (const [key, val] of Object.entries(preserved)) {
      localStorage.setItem(key, val);
    }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl border border-red-200 max-w-lg w-full p-8 text-center">
          <div className="h-12 w-12 rounded-xl bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>

          <h2 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h2>
          <p className="text-sm text-gray-500 mb-4">
            An unexpected error occurred in the application. This is usually caused by corrupted data or a bug.
          </p>

          {this.state.error && (
            <pre className="text-xs text-left bg-gray-50 border rounded-lg p-3 mb-4 overflow-auto max-h-32 text-red-700">
              {this.state.error.message}
            </pre>
          )}

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={this.handleReset}
              className="btn-primary text-sm px-4 py-2"
            >
              Try Again
            </button>
            <button
              onClick={this.handleHardReset}
              className="btn-secondary text-sm px-4 py-2"
            >
              Reset & Reload
            </button>
          </div>

          <p className="text-xs text-gray-400 mt-4">
            "Reset & Reload" clears cached data (except encrypted API keys) and refreshes the page.
          </p>
        </div>
      </div>
    );
  }
}
