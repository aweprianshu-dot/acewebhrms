import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    let message = error.message || 'An unexpected error occurred.';
    try {
      const parsed = JSON.parse(message);
      if (parsed && parsed.error) {
        message = `Database permission or validation error (${parsed.operationType} on ${parsed.path}): ${parsed.error}`;
      }
    } catch {
      // keep original message
    }
    return { hasError: true, message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0D12] text-[#F5F5F5] flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#151922] border border-[#252B36] rounded-xl p-8 shadow-xl">
            <div className="flex items-center gap-3 text-[#FF4634] mb-4">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h2 className="font-display text-lg font-semibold text-[#F5F5F5]">Application Recovery Required</h2>
            </div>
            <p className="text-sm text-[#A1A9B8] leading-relaxed mb-6 break-words">{this.state.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg"
            >
              <RotateCcw className="w-4 h-4" />
              Reload ACE HRMS
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
