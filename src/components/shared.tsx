import React from 'react';

/* ─── Toast ────────────────────────────────────────── */
export function Toast({ message, type, onDismiss }: {
  message: string;
  type: 'success' | 'error' | 'info';
  onDismiss: () => void;
}) {
  const bg = type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-branch-600';
  return (
    <div className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-white ${bg} animate-slideIn max-w-lg`}>
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onDismiss} className="ml-2 text-white/80 hover:text-white shrink-0" aria-label="Dismiss notification">✕</button>
    </div>
  );
}

/* ─── ErrorBanner — prominent dismissible error panel ─ */
export function ErrorBanner({ title, message, details, onDismiss, actions }: {
  title: string;
  message: string;
  details?: string;
  onDismiss?: () => void;
  actions?: React.ReactNode;
}) {
  const [showDetails, setShowDetails] = React.useState(false);
  return (
    <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4 shadow-sm animate-slideIn">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <svg className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-red-800">{title}</h3>
          <p className="text-sm text-red-700 mt-1">{message}</p>
          {details && (
            <div className="mt-2">
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="text-xs text-red-600 hover:text-red-800 font-medium"
              >
                {showDetails ? 'Hide details ▲' : 'Show details ▼'}
              </button>
              {showDetails && (
                <pre className="mt-1 text-sm text-red-600/80 bg-red-100 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {details}
                </pre>
              )}
            </div>
          )}
          {actions && <div className="mt-3 flex items-center gap-2">{actions}</div>}
        </div>
        {onDismiss && (
          <button onClick={onDismiss} className="shrink-0 text-red-400 hover:text-red-600">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Spinner ──────────────────────────────────────── */
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-8 w-8' : 'h-6 w-6';
  return (
    <svg className={`animate-spin ${s} text-branch-600`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/* ─── StatusBadge ──────────────────────────────────── */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    verified: 'badge-green', supported: 'badge-green',
    warning: 'badge-yellow', 'partially-supported': 'badge-yellow', 'needs-review': 'badge-yellow',
    error: 'badge-red', critical: 'badge-red', unsupported: 'badge-red', contradicted: 'badge-red',
    info: 'badge-blue', 'no-consensus': 'badge-blue',
    unverified: 'badge-gray',
  };
  const cls = map[status.toLowerCase()] || 'badge-gray';
  return <span className={cls}>{status}</span>;
}

/* ─── ExpandableCard ───────────────────────────────── */
export function ExpandableCard({ title, badge, children, defaultOpen = false }: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="card">
      <button onClick={() => setOpen(!open)} className="flex items-center justify-between w-full text-left px-4 py-3">
        <div className="flex items-center gap-2">
          <svg className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-semibold text-gray-900">{title}</span>
        </div>
        {badge}
      </button>
      {open && <div className="px-4 pb-4 border-t border-gray-100 pt-3">{children}</div>}
    </div>
  );
}

/* ─── ProgressSteps ────────────────────────────────── */
export function ProgressSteps({ steps, currentStep }: {
  steps: { label: string; description?: string }[];
  currentStep: number;
}) {
  return (
    <nav className="flex items-center gap-2">
      {steps.map((step, i) => (
        <React.Fragment key={i}>
          {i > 0 && <div className={`flex-1 h-0.5 ${i <= currentStep ? 'bg-branch-500' : 'bg-gray-200'}`} />}
          <div className="flex items-center gap-2">
            <div className={`flex items-center justify-center h-8 w-8 rounded-full text-sm font-bold
              ${i < currentStep ? 'bg-branch-600 text-white' : i === currentStep ? 'bg-branch-100 text-branch-700 ring-2 ring-branch-500' : 'bg-gray-100 text-gray-400'}`}>
              {i < currentStep ? '✓' : i + 1}
            </div>
            <div className="hidden sm:block">
              <div className={`text-xs font-medium ${i <= currentStep ? 'text-gray-900' : 'text-gray-400'}`}>{step.label}</div>
              {step.description && <div className="text-xs text-gray-400">{step.description}</div>}
            </div>
          </div>
        </React.Fragment>
      ))}
    </nav>
  );
}

/* ─── EmptyState ───────────────────────────────────── */
export function EmptyState({ icon, title, description, action }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-gray-300 mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-gray-700 mb-1">{title}</h3>
      <p className="text-sm text-gray-500 max-w-md mb-4">{description}</p>
      {action}
    </div>
  );
}

/* ─── ConfirmDialog ────────────────────────────────── */
export function ConfirmDialog({ title, message, onConfirm, onCancel }: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
        <h3 className="text-lg font-bold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
          <button onClick={onConfirm} className="btn-danger text-sm">Confirm</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Tab bar ──────────────────────────────────────── */
export function Tabs({ tabs, active, onChange }: {
  tabs: { key: string; label: string; icon?: React.ReactNode }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex border-b border-gray-200">
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
            ${active === t.key ? 'border-branch-600 text-branch-700' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}
