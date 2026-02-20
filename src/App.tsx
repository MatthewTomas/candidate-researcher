import React, { Suspense } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { Toast, Spinner } from './components/shared';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UnlockGate } from './components/UnlockGate';

// Lazy-loaded pages
const WorkspacePage = React.lazy(() => import('./pages/WorkspacePage'));
const SettingsPage = React.lazy(() => import('./pages/SettingsPage'));

/* ─── Nav icon SVGs ────────────────────────────────── */
const WorkspaceIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
  </svg>
);
const SettingsIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const NAV_ITEMS = [
  { to: '/', label: 'Workspace', icon: <WorkspaceIcon /> },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon /> },
];

function AppShell() {
  const { toast, dismissToast, isUnlocked, lockVault, needsEncryptionSetup } = useApp();
  const location = useLocation();
  const isWorkspace = location.pathname !== '/settings';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-branch-600 flex items-center justify-center">
                <span className="text-white font-bold text-sm">B</span>
              </div>
              <div>
                <h1 className="text-base font-bold text-gray-900 leading-tight">Branch Playground</h1>
                <p className="text-xs text-gray-400 leading-none">Profile Builder & Fact Checker</p>
              </div>
            </div>

            {/* Nav */}
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  aria-label={item.label}
                  className={({ isActive }) =>
                    `flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors
                    ${isActive ? 'bg-branch-50 text-branch-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`
                  }
                >
                  {item.icon}
                  <span className="hidden sm:inline">{item.label}</span>
                </NavLink>
              ))}
            </nav>

            {/* Lock button */}
            <div className="flex items-center gap-2">
              {isUnlocked && !needsEncryptionSetup && (
                <button
                  onClick={lockVault}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                  aria-label="Lock API keys"
                  title="Lock API keys"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className={isWorkspace
        ? 'flex-1 flex flex-col overflow-hidden px-4 sm:px-6 lg:px-8'
        : 'flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6'
      }>
          <Suspense fallback={
            <div className="flex items-center justify-center py-32">
              <Spinner size="lg" />
            </div>
          }>
            <Routes>
              <Route path="/settings" element={<UnlockGate><SettingsPage /></UnlockGate>} />
              <Route path="/*" element={<WorkspacePage />} />
            </Routes>
          </Suspense>
      </main>

      {/* Toast notification */}
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={dismissToast} />}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppShell />
      </AppProvider>
    </ErrorBoundary>
  );
}
