import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { extractClaims } from '../services/audit/claimExtractor';
import { verifyClaim } from '../services/audit/verifier';
import { computeConsensus, buildAuditReport } from '../services/audit/consensus';
import { exportAsBranchJSON, exportAsMarkdown, exportAuditReport } from '../services/exportService';
import { parseAPIError, type ParsedError } from '../services/errorParser';
import { Spinner, StatusBadge, ExpandableCard, EmptyState, ErrorBanner } from '../components/shared';
import type { ExtractedClaim, ClaimAuditResult, AuditReport, CandidateSession } from '../types';

export default function AuditPage() {
  const { sessions, activeSession, setActiveSession, updateSession, settings, getProvider, showToast } = useApp();
  const navigate = useNavigate();

  // Sessions eligible for audit (have a draft built)
  const auditableSessions = sessions.filter(s => s.currentDraft && (s.status === 'ready-for-audit' || s.status === 'audited' || s.status === 'complete' || s.status === 'building'));
  const currentSession = activeSession && activeSession.currentDraft ? activeSession : null;

  const [phase, setPhase] = useState<'idle' | 'extracting' | 'verifying' | 'done' | 'error'>('idle');
  const [claims, setClaims] = useState<ExtractedClaim[]>([]);
  const [results, setResults] = useState<ClaimAuditResult[]>([]);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [error, setError] = useState<ParsedError | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [streamLog]);

  const log = (msg: string) => setStreamLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Load existing report if session has one
  useEffect(() => {
    if (currentSession?.auditReports?.length) {
      const latest = currentSession.auditReports[currentSession.auditReports.length - 1];
      setReport(latest);
      setResults(latest.results);
      setClaims(latest.results.map(r => r.claim));
      setPhase('done');
    } else {
      setReport(null);
      setResults([]);
      setClaims([]);
      setPhase('idle');
    }
    setError(null);
    setStreamLog([]);
  }, [currentSession?.id]);

  /* ─── Run Full Audit ─────────────────────────────── */
  const runAudit = useCallback(async () => {
    if (!currentSession?.currentDraft) return;
    setStreamLog([]);
    setClaims([]);
    setResults([]);
    setReport(null);
    setError(null);

    try {
      // Step 1: Extract claims
      setPhase('extracting');
      log('Extracting verifiable claims from profile…');

      const extractorRole = settings.roleAssignments?.extractor || { provider: 'gemini-free', model: undefined };
      const extractorProvider = await getProvider(extractorRole.provider, extractorRole.model);
      const extractedClaims = await extractClaims(extractorProvider, currentSession.currentDraft, currentSession.candidateName);
      setClaims(extractedClaims);
      log(`Found ${extractedClaims.length} verifiable claims.`);

      // Step 2: Verify each claim with multiple verifiers
      setPhase('verifying');
      const verifierRoles = settings.roleAssignments?.verifiers || [
        { provider: 'gemini-free', model: undefined },
      ];

      setProgress({ current: 0, total: extractedClaims.length });
      const auditResults: ClaimAuditResult[] = [];

      for (let i = 0; i < extractedClaims.length; i++) {
        const claim = extractedClaims[i];
        setProgress({ current: i + 1, total: extractedClaims.length });
        log(`Verifying claim ${i + 1}/${extractedClaims.length}: "${claim.text.slice(0, 60)}…"`);

        const verifierResults = [];
        for (const role of verifierRoles) {
          try {
            const provider = await getProvider(role.provider, role.model);
            const result = await verifyClaim(provider, claim, currentSession.candidateName);
            verifierResults.push(result);
          } catch (err: any) {
            log(`  ⚠ Verifier ${role.provider} failed: ${err.message}`);
          }
        }

        const consensus = computeConsensus(verifierResults);
        const auditResult: ClaimAuditResult = {
          claim,
          verifierResults,
          consensus: consensus.verdict,
          confidence: consensus.confidence,
          explanation: consensus.explanation,
        };
        auditResults.push(auditResult);
        setResults([...auditResults]);
      }

      // Step 3: Build report
      log('Building audit report…');
      const auditReport = buildAuditReport(auditResults, currentSession.candidateName);
      setReport(auditReport);

      // Save to session
      const updated = {
        ...currentSession,
        auditReports: [...(currentSession.auditReports || []), auditReport],
        status: 'audited' as const,
      };
      updateSession(updated);

      setPhase('done');
      log(`✅ Audit complete! ${auditReport.summary.verified} verified, ${auditReport.summary.contradicted} contradicted, ${auditReport.summary.unverified} unverified`);
      showToast('Audit complete!', 'success');
    } catch (err: any) {
      const parsed = parseAPIError(err);
      setError(parsed);
      log(`\u274C ${parsed.title}: ${parsed.message}`);
      setPhase('error');
    }
  }, [currentSession, settings, getProvider, updateSession, showToast]);

  /* ─── Export handlers ────────────────────────────── */
  const handleExportJSON = useCallback(() => {
    if (!currentSession?.currentDraft) return;
    const json = exportAsBranchJSON(currentSession.currentDraft, currentSession.candidateName);
    downloadFile(json, `${currentSession.candidateName.replace(/\s+/g, '_')}_branch.json`, 'application/json');
    showToast('Branch JSON exported', 'success');
  }, [currentSession, showToast]);

  const handleExportMarkdown = useCallback(() => {
    if (!currentSession?.currentDraft) return;
    const md = exportAsMarkdown(currentSession.currentDraft, currentSession.candidateName);
    downloadFile(md, `${currentSession.candidateName.replace(/\s+/g, '_')}_profile.md`, 'text/markdown');
    showToast('Markdown exported', 'success');
  }, [currentSession, showToast]);

  const handleExportAudit = useCallback(() => {
    if (!report) return;
    const md = exportAuditReport(report);
    downloadFile(md, `${currentSession?.candidateName.replace(/\s+/g, '_')}_audit.md`, 'text/markdown');
    showToast('Audit report exported', 'success');
  }, [report, currentSession, showToast]);

  /* ─── Render ─────────────────────────────────────── */
  if (auditableSessions.length === 0) {
    return (
      <EmptyState
        icon={<svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        title="No Profiles to Audit"
        description="Build a candidate profile first, then come here to fact-check it with multiple AI verifiers."
        action={<button className="btn-primary text-sm" onClick={() => navigate('/build')}>Go to Build</button>}
      />
    );
  }

  const isRunning = phase === 'extracting' || phase === 'verifying';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Audit & Export</h2>
          <p className="text-sm text-gray-500">
            Multi-verifier fact-check for built profiles
          </p>
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <>
              <button className="btn-secondary text-sm" onClick={handleExportJSON}>Export JSON</button>
              <button className="btn-secondary text-sm" onClick={handleExportMarkdown}>Export MD</button>
              <button className="btn-secondary text-sm" onClick={handleExportAudit}>Export Audit</button>
            </>
          )}
        </div>
      </div>

      {/* Session selector */}
      <div className="card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm font-medium text-gray-700">Profile:</label>
          <select
            className="input text-sm flex-1 max-w-xs"
            value={currentSession?.id || ''}
            onChange={e => {
              const s = sessions.find(sess => sess.id === e.target.value);
              if (s) setActiveSession(s);
            }}
          >
            {!currentSession && <option value="">Select a profile…</option>}
            {auditableSessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.candidateName} — {s.status} ({s.builderRounds.length} rounds, {s.auditReports?.length || 0} audits)
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-400">
            {auditableSessions.length} profile{auditableSessions.length !== 1 ? 's' : ''} available
          </span>
        </div>
      </div>

      {!currentSession ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-gray-400">Select a profile above to audit or export.</p>
        </div>
      ) : (
      <>

      {/* Error banner */}
      {error && (
        <ErrorBanner
          title={error.title}
          message={error.message}
          details={error.details}
          onDismiss={() => setError(null)}
          actions={error.retryable ? <button className="btn-primary text-xs" onClick={runAudit}>Retry</button> : undefined}
        />
      )}

      {/* Controls */}
      <div className="card p-4 flex items-center gap-4">
        <button className="btn-primary" onClick={runAudit} disabled={isRunning}>
          {isRunning ? <><Spinner size="sm" /> Auditing…</> : report ? 'Re-run Audit' : 'Start Audit'}
        </button>
        {isRunning && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-48 bg-gray-200 rounded-full h-2">
              <div className="bg-branch-600 h-2 rounded-full transition-all" style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }} />
            </div>
            <span>{progress.current}/{progress.total}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Claims & results */}
        <div className="lg:col-span-2 space-y-3">
          {report && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Audit Summary</h3>
              <div className="grid grid-cols-4 gap-4 text-center">
                <SummaryBox label="Verified" value={report.summary.verified} color="text-green-600" />
                <SummaryBox label="Contradicted" value={report.summary.contradicted} color="text-red-600" />
                <SummaryBox label="Unverified" value={report.summary.unverified} color="text-yellow-600" />
                <SummaryBox label="Total" value={report.summary.totalClaims} color="text-gray-700" />
              </div>
              <div className="mt-3 text-xs text-gray-500">
                Overall confidence: <strong>{(report.summary.overallConfidence * 100).toFixed(0)}%</strong>
              </div>
            </div>
          )}

          {results.length > 0 ? (
            results.map((result, i) => (
              <ExpandableCard
                key={result.claim.id}
                title={`Claim ${i + 1}`}
                badge={<StatusBadge status={result.consensus} />}
              >
                <div className="space-y-3">
                  <p className="text-sm text-gray-800">{result.claim.text}</p>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>Section: {result.claim.section}</span>
                    <span>Type: {result.claim.claimType}</span>
                    <span>Confidence: {(result.confidence * 100).toFixed(0)}%</span>
                  </div>
                  {result.claim.sourceUrl && (
                    <div className="text-xs text-gray-400">
                      Source: <a href={result.claim.sourceUrl} target="_blank" rel="noopener" className="text-branch-600 hover:underline">{result.claim.sourceUrl}</a>
                    </div>
                  )}
                  <p className="text-xs text-gray-600 bg-gray-50 rounded p-2">{result.explanation}</p>
                  {result.verifierResults.map((vr, j) => (
                    <div key={j} className="text-xs border-l-2 border-gray-200 pl-2">
                      <div className="flex items-center gap-2">
                        <strong className="text-gray-600">{vr.providerUsed}</strong>
                        <StatusBadge status={vr.verdict} />
                        <span className="text-gray-400">{(vr.confidence * 100).toFixed(0)}%</span>
                      </div>
                      <p className="text-gray-500 mt-0.5">{vr.explanation}</p>
                    </div>
                  ))}
                </div>
              </ExpandableCard>
            ))
          ) : phase === 'idle' && (
            <div className="card p-8 text-center">
              <p className="text-sm text-gray-400">
                Click "Start Audit" to extract and verify all claims in the profile.
              </p>
            </div>
          )}
        </div>

        {/* Right column: log */}
        <div className="card">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">Activity Log</h3>
          </div>
          <div ref={logRef} className="p-3 max-h-96 overflow-y-auto font-mono text-xs text-gray-600 space-y-0.5">
            {streamLog.length === 0
              ? <span className="text-gray-400 italic">Waiting to start…</span>
              : streamLog.map((line, i) => <div key={i}>{line}</div>)
            }
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function SummaryBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
