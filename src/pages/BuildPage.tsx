import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { runWriter, addSourceToProfile } from '../services/agents/writer';
import { runSpecializedCritics, type OrchestratorProviders } from '../services/agents/criticOrchestrator';
import { computeScore } from '../services/scoring';
import { parseAPIError, type ParsedError } from '../services/errorParser';
import { getCurrentMonthSpend } from '../services/costTracker';
import { diffText, textsAreDifferent, type DiffSegment } from '../services/diffUtils';
import { buildCandidateLinks } from '../services/htmlExtractor';
import { Spinner, StatusBadge, ExpandableCard, EmptyState, ProgressSteps, ErrorBanner } from '../components/shared';
import type { BuilderRound, CriticFeedback, StagingDraft, Source, PipelineMode } from '../types';
import LinksPanel from '../components/LinksPanel';
import SourcePopup from '../components/SourcePopup';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Phase = 'idle' | 'writing' | 'critiquing' | 'waiting-for-human' | 'converged' | 'error' | 'retrying';

/** Retry config for transient errors */
const RETRY_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 3000,    // 3s, 6s, 12s, 24s, 48s
  maxDelayMs: 65000,    // cap at 65s (survives full Gemini RPM window reset)
  /** Extra delay for rate-limit errors */
  quotaDelayMs: 30000,
};

/** Categories of errors that are safe to auto-retry */
const RETRYABLE_CATEGORIES = new Set(['parse', 'quota', 'network', 'unknown']);

export default function BuildPage() {
  const { activeSession, updateSession, settings, getProvider, showToast } = useApp();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('idle');
  const [currentRound, setCurrentRound] = useState(0);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [newSourceTitle, setNewSourceTitle] = useState('');
  const [error, setError] = useState<ParsedError | null>(null);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const streamLogRef = useRef<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  // Auto-scroll log
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [streamLog]);

  // Restore build state from session on mount
  useEffect(() => {
    if (activeSession?.buildLog?.length && streamLog.length === 0) {
      setStreamLog(activeSession.buildLog);
      streamLogRef.current = activeSession.buildLog;
    }
    if (activeSession) {
      if (activeSession.status === 'ready-for-audit' || activeSession.status === 'audited' || activeSession.status === 'complete') {
        setPhase('converged');
      } else if (activeSession.builderRounds.length > 0 && activeSession.status === 'building') {
        setPhase('waiting-for-human');
      }
    }
  }, [activeSession?.id]);

  const log = (msg: string) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setStreamLog(prev => {
      const next = [...prev, entry];
      streamLogRef.current = next;
      return next;
    });
  };

  /** Sleep helper for retry backoff */
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Retry wrapper — retries retryable AI calls with exponential backoff.
   * Logs each attempt and wait. Saves session progress before retrying.
   */
  const withRetry = useCallback(async <T,>(
    label: string,
    fn: () => Promise<T>,
    roundNum: number,
    sessionSnapshot?: typeof activeSession,
  ): Promise<T> => {
    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const parsed = parseAPIError(err);
        const canRetry = RETRYABLE_CATEGORIES.has(parsed.category) && attempt < RETRY_CONFIG.maxAttempts;

        if (!canRetry) {
          // Save progress before giving up
          if (sessionSnapshot) {
            updateSession({ ...sessionSnapshot, buildLog: streamLogRef.current });
          }
          throw err;
        }

        // Calculate delay — longer for quota errors
        const baseDelay = parsed.category === 'quota'
          ? RETRY_CONFIG.quotaDelayMs
          : RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
        const delay = Math.min(baseDelay, RETRY_CONFIG.maxDelayMs);
        const delaySec = (delay / 1000).toFixed(0);

        log(`Round ${roundNum}: ⚠ ${label} failed (${parsed.title}) — attempt ${attempt}/${RETRY_CONFIG.maxAttempts}`);
        log(`Round ${roundNum}:   ${parsed.message.slice(0, 120)}`);
        log(`Round ${roundNum}: ⏳ Waiting ${delaySec}s before retry…`);
        setPhase('retrying');

        // Save progress so far before waiting
        if (sessionSnapshot) {
          updateSession({ ...sessionSnapshot, buildLog: streamLogRef.current });
        }

        await sleep(delay);

        if (abortRef.current) throw new Error('Build cancelled by user');

        log(`Round ${roundNum}: 🔄 Retrying ${label} (attempt ${attempt + 1}/${RETRY_CONFIG.maxAttempts})…`);
      }
    }
    // Should not reach here, but just in case
    throw new Error(`${label} failed after ${RETRY_CONFIG.maxAttempts} attempts`);
  }, [updateSession]);

  /* ─── Run one Writer → Critic round ──────────────── */
  const runOneRound = useCallback(async (session: typeof activeSession, roundNum: number): Promise<{
    draft: Partial<StagingDraft>;
    feedback: CriticFeedback;
    converged: boolean;
  }> => {
    if (!session) throw new Error('No active session');

    const pipelineMode: PipelineMode = settings.pipelineMode || 'balanced';
    const skipCritics = pipelineMode === 'draft';

    // Writer step
    setPhase('writing');
    const writerRole = settings.roleAssignments?.writer || { provider: 'gemini-free', model: undefined };
    log(`Round ${roundNum}: 📝 Writer starting (${writerRole.provider}${writerRole.model ? ` / ${writerRole.model}` : ''})…`);

    const writerProvider = await getProvider(writerRole.provider, writerRole.model);

    const previousFeedback = session.builderRounds.length > 0
      ? session.builderRounds[session.builderRounds.length - 1].criticFeedback
      : undefined;

    if (previousFeedback) {
      log(`Round ${roundNum}: Addressing ${previousFeedback.issues.length} issues from previous round (score was ${previousFeedback.overallScore}/100)`);
    }

    const extractedText = session.extractedProfile
      ? JSON.stringify(session.extractedProfile)
      : '';
    const additionalSourcesText = session.additionalSources
      .map(s => `- ${s.title}: ${s.url}`).join('\n');

    // Cap source content to prevent prompt explosion (saves output token budget)
    const MAX_SOURCE_CHARS = 12000;
    let rawSourceContext = [extractedText, additionalSourcesText].filter(Boolean).join('\n\n');
    if (rawSourceContext.length > MAX_SOURCE_CHARS) {
      rawSourceContext = rawSourceContext.slice(0, MAX_SOURCE_CHARS) + '\n\n[…source content truncated for length]';
      log(`Round ${roundNum}: ⚠ Source content truncated to ${MAX_SOURCE_CHARS} chars to fit model context`);
    }
    const sourceContext = rawSourceContext;

    if (session.extractedProfile) {
      log(`Round ${roundNum}: Using imported profile data + ${session.additionalSources.length} additional source(s)`);
      // Log specific sources being used
      if (session.extractedProfile.links?.length > 0) {
        const siteLinks = session.extractedProfile.links.slice(0, 5);
        for (const link of siteLinks) {
          log(`Round ${roundNum}:   📄 ${link.mediaType}: ${link.url}`);
        }
        if (session.extractedProfile.links.length > 5) {
          log(`Round ${roundNum}:   … and ${session.extractedProfile.links.length - 5} more links`);
        }
      }
      if (session.extractedProfile.sources?.length > 0) {
        log(`Round ${roundNum}:   🌐 ${session.extractedProfile.sources.length} source(s) from imported profile`);
        for (const src of session.extractedProfile.sources.slice(0, 3)) {
          log(`Round ${roundNum}:   → ${src.sourceType}: ${src.url}`);
        }
      }
    } else if (session.additionalSources.length > 0) {
      log(`Round ${roundNum}: Using ${session.additionalSources.length} source(s) as research material`);
    }
    if (session.additionalSources.length > 0) {
      for (const src of session.additionalSources) {
        log(`Round ${roundNum}:   🔗 ${src.title}: ${src.url}`);
      }
    }

    const draft = await withRetry('Writer', () => runWriter(writerProvider, {
      candidateName: session.candidateName,
      sourceContent: sourceContext,
      previousDraft: session.currentDraft ?? undefined,
      criticFeedback: previousFeedback ?? undefined,
    }), roundNum, session);

    setPhase('writing');

    log(`Round ${roundNum}: ✓ Writer produced ${draft.bios?.length || 0} bios, ${draft.issues?.length || 0} issues`);

    // Log source URLs the writer cited
    const draftUrls = new Set<string>();
    for (const bio of draft.bios || []) {
      for (const s of bio.sources || []) if (s.url) draftUrls.add(s.url);
    }
    for (const issue of draft.issues || []) {
      for (const stance of issue.stances || []) {
        for (const s of stance.sources || []) if (s.url) draftUrls.add(s.url);
      }
    }
    if (draftUrls.size > 0) {
      log(`Round ${roundNum}: Writer cited ${draftUrls.size} unique source(s):`);
      let count = 0;
      for (const url of draftUrls) {
        if (count++ >= 6) { log(`Round ${roundNum}:   … and ${draftUrls.size - 6} more`); break; }
        log(`Round ${roundNum}:   🌐 ${url}`);
      }
    }

    // Save draft immediately so the UI shows it before the critic runs
    updateSession({ ...session, currentDraft: draft, status: 'building', buildLog: streamLogRef.current });

    // Build candidate links from extracted data
    if (session.extractedProfile?.links || session.extractedProfile?.sources) {
      const candidateLinks = buildCandidateLinks(
        session.extractedProfile?.links || [],
        session.extractedProfile?.sources || [],
      );
      updateSession({ ...session, currentDraft: draft, candidateLinks, status: 'building', buildLog: streamLogRef.current });
    }

    let feedback: CriticFeedback;
    let agentResults: { label: string; feedback: CriticFeedback }[] = [];

    if (skipCritics) {
      // Draft mode — skip critics, return a dummy perfect feedback
      log(`Round ${roundNum}: ⚡ Draft mode — skipping critics for speed`);
      feedback = {
        overallScore: 100,
        templateComplianceScore: 100,
        issues: [],
        overallAssessment: 'Draft mode — no critic review performed.',
        failedAgents: [],
      };
    } else {
      // Critic step — 3 specialized or combined agents
      setPhase('critiquing');
      const parallelism = settings.criticParallelism ?? 'parallel';

      // Resolve providers for each specialized critic
      const fcRole = settings.roleAssignments?.factChecker || settings.roleAssignments?.critic || { provider: 'gemini-free' as const };
      const lrRole = settings.roleAssignments?.languageReviewer || settings.roleAssignments?.critic || { provider: 'gemini-free' as const };
      const saRole = settings.roleAssignments?.styleAuditor || settings.roleAssignments?.critic || { provider: 'gemini-free' as const };

      const criticMode = settings.criticMode || 'combined';
      log(`Round ${roundNum}: 🔍 Starting ${criticMode === 'combined' ? 'combined' : parallelism} review:`);
      if (criticMode !== 'combined') {
        log(`Round ${roundNum}:   🔬 Fact Checker (${fcRole.provider}${fcRole.model ? ` / ${fcRole.model}` : ''})`);
        log(`Round ${roundNum}:   📝 Language Reviewer (${lrRole.provider}${lrRole.model ? ` / ${lrRole.model}` : ''})`);
        log(`Round ${roundNum}:   📐 Style Auditor (${saRole.provider}${saRole.model ? ` / ${saRole.model}` : ''})`);
      } else {
        log(`Round ${roundNum}:   🔬 Combined Critic (${fcRole.provider}${fcRole.model ? ` / ${fcRole.model}` : ''})`);
      }
      if (draftUrls.size > 0) {
        log(`Round ${roundNum}: Fact Checker will verify ${draftUrls.size} cited source(s)`);
      }

      const criticProviders: OrchestratorProviders = {
        factChecker: await getProvider(fcRole.provider, fcRole.model),
        languageReviewer: await getProvider(lrRole.provider, lrRole.model),
        styleAuditor: await getProvider(saRole.provider, saRole.model),
      };

      const result = await withRetry('Critics', () => runSpecializedCritics(
        criticProviders,
        { candidateName: session.candidateName, draft, sourceContent: sourceContext },
        settings,
        {
          onAgentStart: (agent, pass, total) => {
            const passLabel = total > 1 ? ` (pass ${pass}/${total})` : '';
            log(`Round ${roundNum}: ▶ ${agent} starting${passLabel}…`);
          },
          onAgentComplete: (agent, pass, agentFeedback) => {
            const ic = agentFeedback.issues.length;
            const crit = agentFeedback.issues.filter(i => i.severity === 'critical').length;
            const maj = agentFeedback.issues.filter(i => i.severity === 'major').length;
            log(`Round ${roundNum}: ✓ ${agent}: score ${agentFeedback.overallScore}/100, ${ic} issue(s)${crit ? ` (${crit} critical)` : ''}${maj ? ` (${maj} major)` : ''}`);
          },
          onAgentRetry: (agent, attempt, maxAttempts, errorMsg, delaySec) => {
            if (delaySec > 0) {
              log(`Round ${roundNum}: ⚠ ${agent} failed (attempt ${attempt}/${maxAttempts}): ${errorMsg}`);
              log(`Round ${roundNum}: ⏳ ${agent} retrying in ${delaySec}s…`);
            } else {
              log(`Round ${roundNum}: ✗ ${agent} failed permanently after ${maxAttempts} attempts — continuing with other agents`);
            }
          },
        },
      ), roundNum, { ...session, currentDraft: draft });

      feedback = result.merged;
      agentResults = result.agentResults;
    }

    const criticalCount = feedback.issues.filter(i => i.severity === 'critical').length;
    const majorCount = feedback.issues.filter(i => i.severity === 'major').length;
    const minorCount = feedback.issues.filter(i => i.severity === 'minor').length;
    const suggestionCount = feedback.issues.filter(i => i.severity === 'suggestion').length;

    // Composite scores (deterministic — computed from issues, not AI-reported)
    log(`Round ${roundNum}: ── Combined Results ──`);
    log(`Round ${roundNum}: Composite score: ${feedback.overallScore}/100 (template: ${feedback.templateComplianceScore}/100)`);
    for (const ar of agentResults) {
      const agentScore = computeScore(ar.feedback.issues);
      log(`Round ${roundNum}:   ${ar.label}: ${agentScore}/100 (${ar.feedback.issues.length} issues)`);
    }
    if (feedback.failedAgents?.length) {
      for (const fa of feedback.failedAgents) {
        log(`Round ${roundNum}:   ❌ ${fa}: FAILED (score 0/100 — unverified)`);
      }
    }

    if (feedback.issues.length === 0 && !feedback.failedAgents?.length) {
      log(`Round ${roundNum}: No issues found — clean review!`);
    } else {
      log(`Round ${roundNum}: Total: ${feedback.issues.length} issues — ${criticalCount} critical, ${majorCount} major, ${minorCount} minor, ${suggestionCount} suggestions`);

      // Category breakdown
      const categories: Record<string, number> = {};
      for (const issue of feedback.issues) {
        categories[issue.category] = (categories[issue.category] || 0) + 1;
      }
      const catSummary = Object.entries(categories).map(([k, v]) => `${k}: ${v}`).join(', ');
      log(`Round ${roundNum}: Categories: ${catSummary}`);

      // Top critical/major issues
      const topIssues = feedback.issues
        .filter(i => i.severity === 'critical' || i.severity === 'major')
        .slice(0, 4);
      for (const issue of topIssues) {
        log(`Round ${roundNum}: ⚠ [${issue.severity}] ${issue.category} in ${issue.section}: ${issue.description.slice(0, 120)}`);
      }
    }

    const failedAgentCount = feedback.failedAgents?.length ?? 0;
    const converged = feedback.overallScore >= (settings.convergenceThreshold || 80)
      && criticalCount === 0
      && majorCount === 0
      && failedAgentCount === 0;

    if (converged) {
      log(`Round ${roundNum}: 🎯 Meets convergence threshold (${settings.convergenceThreshold || 80}+, 0 critical, 0 major, all agents passed)`);
    } else {
      const reasons: string[] = [];
      if (feedback.overallScore < (settings.convergenceThreshold || 80)) {
        reasons.push(`score ${feedback.overallScore} < threshold ${settings.convergenceThreshold || 80}`);
      }
      if (criticalCount > 0) reasons.push(`${criticalCount} critical issue(s) remain`);
      if (majorCount > 0) reasons.push(`${majorCount} major issue(s) remain`);
      if (failedAgentCount > 0) reasons.push(`${failedAgentCount} agent(s) failed — cannot verify`);
      log(`Round ${roundNum}: Not converged yet (${reasons.join(', ')})`);
    }

    return { draft, feedback, converged };
  }, [settings, getProvider, updateSession]);

  /* ─── Run full adversarial loop (resumes from last completed round) ── */
  const runLoop = useCallback(async () => {
    if (!activeSession) return;
    // Don't clear logs — append to existing log so we never lose history
    setError(null);
    abortRef.current = false;

    let session = { ...activeSession };
    const maxRounds = settings.maxAdversarialRounds || 3;
    const pipelineMode: PipelineMode = settings.pipelineMode || 'balanced';
    const effectiveMaxRounds =
      pipelineMode === 'thorough' ? maxRounds :
      pipelineMode === 'balanced' ? Math.min(maxRounds, 2) :
      1; // fast / draft

    // Pre-flight spending cap check
    if (settings.spendingCapUsd > 0) {
      const currentSpend = getCurrentMonthSpend();
      if (currentSpend >= settings.spendingCapUsd) {
        const err = parseAPIError(new Error(
          `Monthly spending cap reached ($${currentSpend.toFixed(2)} / $${settings.spendingCapUsd.toFixed(2)}). Increase your cap in Settings or switch to free-tier models.`
        ));
        setError(err);
        setPhase('error');
        return;
      }
      log(`💰 Current month spend: $${currentSpend.toFixed(4)} / $${settings.spendingCapUsd.toFixed(2)} cap`);
    }

    const completedRounds = session.builderRounds.length;
    const isResume = completedRounds > 0;

    if (isResume) {
      log(`🔄 Resuming adversarial build from round ${completedRounds + 1} (${completedRounds} round(s) already completed)`);
    } else {
      log(`Starting adversarial build: up to ${effectiveMaxRounds} rounds (${pipelineMode} mode), convergence at ${settings.convergenceThreshold || 80}+, mode: ${settings.convergenceMode}`);
    }

    try {
      const startRound = session.builderRounds.length + 1;
      const endRound = startRound + effectiveMaxRounds - 1;
      log(`Rounds ${startRound}–${endRound} planned (convergence at ${settings.convergenceThreshold || 80}+, mode: ${settings.convergenceMode})`);

      for (let round = startRound; round <= endRound; round++) {
        if (abortRef.current) {
          log('⏹ Build cancelled by user');
          break;
        }
        setCurrentRound(round);

        const result = await runOneRound(session, round);

        const builderRound: BuilderRound = {
          roundNumber: round,
          writerOutput: result.draft,
          criticFeedback: result.feedback,
          timestamp: new Date().toISOString(),
        };

        session = {
          ...session,
          currentDraft: result.draft,
          builderRounds: [...session.builderRounds, builderRound],
          status: 'building',
          buildLog: streamLogRef.current,
        };
        updateSession(session);

        if (result.converged) {
          log(`✅ Converged at round ${round}! Score: ${result.feedback.overallScore}/100`);
          setPhase('converged');
          session = { ...session, status: 'ready-for-audit', buildLog: streamLogRef.current };
          updateSession(session);
          showToast('Profile converged successfully!', 'success');
          return;
        }

        // Human-in-the-loop check
        if (settings.convergenceMode === 'human-in-the-loop') {
          log(`⏸ Awaiting human review after round ${round}…`);
          session = { ...session, buildLog: streamLogRef.current };
          updateSession(session);
          setPhase('waiting-for-human');
          return;
        }
      }

      log(`⚠ Max rounds (${effectiveMaxRounds}) reached without convergence.`);
      setPhase('waiting-for-human');
      showToast('Max rounds reached. Review and continue or accept.', 'info');
    } catch (err: any) {
      const parsed = parseAPIError(err);
      setError(parsed);
      log(`❌ ${parsed.title}: ${parsed.message}`);
      // ALWAYS save progress — never lose work
      session = { ...session, buildLog: streamLogRef.current };
      updateSession(session);

      if (parsed.retryable) {
        log(`ℹ This error is retryable. Click "Resume" to continue from round ${session.builderRounds.length + 1}.`);
      } else {
        log(`ℹ This error requires manual action: ${parsed.action || 'Check Settings'}`);
      }
      setPhase('error');
    }
  }, [activeSession, settings, updateSession, showToast, runOneRound, withRetry]);

  /* ─── Continue after human review (resumes, doesn't restart) ──── */
  const handleContinue = useCallback(() => {
    setError(null);
    runLoop();
  }, [runLoop]);

  /* ─── Accept current profile ─────────────────────── */
  const handleAccept = useCallback(() => {
    if (!activeSession) return;
    updateSession({ ...activeSession, status: 'ready-for-audit' });
    setPhase('converged');
    showToast('Profile accepted! Proceed to Audit.', 'success');
  }, [activeSession, updateSession, showToast]);

  /* ─── Retry / Resume after error (resumes from last round) ───── */
  const handleRetry = useCallback(() => {
    setError(null);
    runLoop();
  }, [runLoop]);

  /* ─── Cancel a running build ─────────────────────── */
  const handleCancel = useCallback(() => {
    abortRef.current = true;
    log('⏹ Cancelling build after current step completes…');
  }, []);

  /* ─── Add incremental source ─────────────────────── */
  const handleAddSource = useCallback(async () => {
    if (!activeSession || !activeSession.currentDraft || !newSourceUrl.trim()) return;

    log(`Adding source: ${newSourceTitle || newSourceUrl}`);
    const writerRole = settings.roleAssignments?.writer || { provider: 'gemini-free', model: undefined };
    const writerProvider = await getProvider(writerRole.provider, writerRole.model);

    try {
      setPhase('writing');
      const updated = await addSourceToProfile(writerProvider, {
        currentDraft: activeSession.currentDraft,
        candidateName: activeSession.candidateName,
        newSource: { url: newSourceUrl, title: newSourceTitle || newSourceUrl, content: '' },
      });

      const session = {
        ...activeSession,
        currentDraft: updated,
        additionalSources: [...activeSession.additionalSources, { url: newSourceUrl, title: newSourceTitle || newSourceUrl, addedAt: new Date().toISOString() }],
      };
      updateSession(session);
      setNewSourceUrl('');
      setNewSourceTitle('');
      setPhase('idle');
      log('Source incorporated into profile.');
      showToast('Source added and profile updated', 'success');
    } catch (err: any) {
      const parsed = parseAPIError(err);
      setError(parsed);
      setPhase('error');
    }
  }, [activeSession, newSourceUrl, newSourceTitle, settings, getProvider, updateSession, showToast]);

  /* ─── Render ─────────────────────────────────────── */
  if (!activeSession) {
    return (
      <EmptyState
        icon={<svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>}
        title="No Active Session"
        description="Add candidates from the Candidates tab to get started."
        action={<button className="btn-primary text-sm" onClick={() => navigate('/candidates')}>Go to Candidates</button>}
      />
    );
  }

  const lastRound = activeSession.builderRounds[activeSession.builderRounds.length - 1];
  const isRunning = phase === 'writing' || phase === 'critiquing' || phase === 'retrying';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Build Profile</h2>
          <p className="text-sm text-gray-500">
            Adversarial Writer/Critic loop for <strong>{activeSession.candidateName}</strong>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={phase === 'converged' ? 'verified' : phase === 'error' ? 'error' : activeSession.status} />
          {activeSession.status === 'ready-for-audit' && (
            <button className="btn-primary text-sm" onClick={() => navigate('/audit')}>
              Go to Audit →
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      <ProgressSteps
        steps={[
          { label: 'Import', description: 'Add sources' },
          { label: 'Build', description: 'Writer / Critic' },
          { label: 'Export', description: 'JSON output' },
        ]}
        currentStep={
          activeSession.status === 'ready-for-audit' || activeSession.status === 'audited' || activeSession.status === 'complete'
            ? 2
            : 1
        }
      />

      {/* Error banner */}
      {error && (
        <ErrorBanner
          title={error.title}
          message={error.message}
          details={error.details}
          onDismiss={() => setError(null)}
          actions={
            <>
              {error.retryable && (
                <button className="btn-primary text-xs" onClick={handleRetry}>
                  Try Again
                </button>
              )}
              {(error.category === 'config' || error.category === 'auth' || error.category === 'budget') && (
                <button className="btn-secondary text-xs" onClick={() => navigate('/settings')}>
                  Open Settings
                </button>
              )}
              {error.action && (
                <span className="text-xs text-gray-500 italic">{error.action}</span>
              )}
            </>
          }
        />
      )}

      {/* Controls */}
      <div className="card p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            className="btn-primary"
            onClick={runLoop}
            disabled={isRunning || phase === 'converged'}
          >
            {isRunning ? <><Spinner size="sm" /> Running…</> :
              activeSession.builderRounds.length === 0 ? 'Start Building' : 'Run Another Round'}
          </button>

          {isRunning && (
            <button className="btn-secondary text-xs" onClick={handleCancel}>Cancel</button>
          )}

          {phase === 'waiting-for-human' && (
            <>
              <button className="btn-secondary" onClick={handleContinue}>Continue Loop</button>
              <button className="btn-primary" onClick={handleAccept}>Accept & Move to Audit</button>
            </>
          )}

          {phase === 'converged' && (
            <span className="text-sm text-green-700 font-medium">✅ Profile converged</span>
          )}

          <span className="text-xs text-gray-400 ml-auto">
            Rounds: {activeSession.builderRounds.length} / Max: {settings.maxAdversarialRounds || 3} |
            Mode: {settings.convergenceMode} |
            Pipeline: {settings.pipelineMode || 'balanced'}
            {settings.spendingCapUsd > 0 && (
              <> | Cap: ${settings.spendingCapUsd.toFixed(2)}</>
            )}
          </span>
        </div>

        {/* Phase indicator */}
        {isRunning && (
          <div className={`mt-3 flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${
            phase === 'retrying' ? 'text-amber-700 bg-amber-50' : 'text-branch-700 bg-branch-50'
          }`}>
            <Spinner size="sm" />
            <span className="font-medium">
              {phase === 'writing' && `Round ${currentRound}: Writer is generating the profile draft…`}
              {phase === 'critiquing' && `Round ${currentRound}: Critic agents are reviewing for errors, bias, missing sources…`}
              {phase === 'retrying' && `Round ${currentRound}: Retrying after transient error — waiting before next attempt…`}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: current draft + add source */}
        <div className="lg:col-span-2 space-y-4">
          {/* Draft preview with round tabs */}
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-700">Draft</h3>
                <div className="flex items-center gap-3">
                  {activeSession.builderRounds.length > 1 && (
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                      <input type="checkbox" checked={showDiff} onChange={e => setShowDiff(e.target.checked)} className="rounded border-gray-300" />
                      Show changes
                    </label>
                  )}
                  {activeSession.currentDraft && (
                    <span className="text-xs text-gray-400">
                      {activeSession.currentDraft.bios?.length || 0} bios ·{' '}
                      {activeSession.currentDraft.issues?.length || 0} issues
                    </span>
                  )}
                </div>
              </div>
              {activeSession.builderRounds.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                  <button
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${selectedRound === null ? 'bg-branch-100 text-branch-700' : 'text-gray-500 hover:bg-gray-100'}`}
                    onClick={() => setSelectedRound(null)}
                  >
                    Latest
                  </button>
                  {[...activeSession.builderRounds].reverse().map(r => (
                    <button
                      key={r.roundNumber}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${selectedRound === r.roundNumber ? 'bg-branch-100 text-branch-700' : 'text-gray-500 hover:bg-gray-100'}`}
                      onClick={() => setSelectedRound(r.roundNumber)}
                    >
                      Round {r.roundNumber}
                      <span className="ml-1 text-[10px] text-gray-400">{r.criticFeedback.overallScore}pts</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 max-h-[600px] overflow-y-auto">
              {(() => {
                // Determine which draft and optional previous draft to show
                const viewDraft = selectedRound !== null
                  ? activeSession.builderRounds.find(r => r.roundNumber === selectedRound)?.writerOutput
                  : activeSession.currentDraft;

                const prevRoundNum = selectedRound !== null ? selectedRound - 1 : activeSession.builderRounds.length - 1;
                const prevDraft = showDiff && prevRoundNum >= 1
                  ? activeSession.builderRounds.find(r => r.roundNumber === prevRoundNum)?.writerOutput
                  : undefined;

                if (!viewDraft) {
                  return <p className="text-sm text-gray-400 italic">No draft yet. Click "Start Building" to begin.</p>;
                }
                return <DraftPreview draft={viewDraft} previousDraft={prevDraft} />;
              })()}
            </div>
          </div>

          {/* Links Panel */}
          {activeSession.candidateLinks && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Candidate Links</h3>
              <LinksPanel links={activeSession.candidateLinks} compact />
            </div>
          )}

          {/* Add source */}
          {activeSession.currentDraft && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Add Incremental Source</h3>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="label">URL</label>
                  <input className="input text-sm" placeholder="https://..." value={newSourceUrl} onChange={e => setNewSourceUrl(e.target.value)} />
                </div>
                <div className="flex-1">
                  <label className="label">Title (optional)</label>
                  <input className="input text-sm" placeholder="Article title" value={newSourceTitle} onChange={e => setNewSourceTitle(e.target.value)} />
                </div>
                <button className="btn-secondary text-sm whitespace-nowrap" onClick={handleAddSource} disabled={!newSourceUrl.trim() || isRunning}>
                  Add Source
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right column: rounds log + feedback */}
        <div className="space-y-4">
          {/* Stream log */}
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">Activity Log</h3>
              {isRunning && <Spinner size="sm" />}
            </div>
            <div
              ref={logRef}
              className="p-3 max-h-64 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-0.5"
              style={{ backgroundColor: '#1a1a2e' }}
            >
              {streamLog.length === 0
                ? <span className="text-gray-500 italic">Waiting to start…</span>
                : streamLog.map((line, i) => (
                  <div key={i} className={
                    line.includes('✅') || line.includes('✓') ? 'text-green-400' :
                    line.includes('❌') ? 'text-red-400' :
                    line.includes('⚠') ? 'text-yellow-400' :
                    line.includes('📝') ? 'text-blue-300' :
                    line.includes('🔍') ? 'text-purple-300' :
                    line.includes('💰') ? 'text-amber-300' :
                    line.includes('🎯') ? 'text-emerald-300' :
                    line.includes('⏸') ? 'text-orange-300' :
                    'text-gray-300'
                  }>{line}</div>
                ))
              }
            </div>
          </div>

          {/* Previous rounds */}
          {activeSession.builderRounds.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-700">Round History</h3>
              {[...activeSession.builderRounds].reverse().map(round => (
                <ExpandableCard
                  key={round.roundNumber}
                  title={`Round ${round.roundNumber}`}
                  badge={<StatusBadge status={round.criticFeedback.overallScore >= 80 ? 'verified' : round.criticFeedback.overallScore >= 50 ? 'warning' : 'critical'} />}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                      <span>Score: <strong className="text-gray-900">{round.criticFeedback.overallScore}/100</strong></span>
                      <span>Template: <strong>{round.criticFeedback.templateComplianceScore}/100</strong></span>
                      <span>Issues: {round.criticFeedback.issues.length}</span>
                      <span>{new Date(round.timestamp).toLocaleTimeString()}</span>
                    </div>
                    {round.criticFeedback.failedAgents && round.criticFeedback.failedAgents.length > 0 && (
                      <div className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">
                        Failed agents: {round.criticFeedback.failedAgents.join(', ')} (scored 0 — blocked convergence)
                      </div>
                    )}
                    {round.criticFeedback.overallAssessment && (
                      <p className="text-xs text-gray-600 italic border-l-2 border-gray-200 pl-2">
                        {round.criticFeedback.overallAssessment.slice(0, 200)}
                        {round.criticFeedback.overallAssessment.length > 200 ? '…' : ''}
                      </p>
                    )}
                    {round.criticFeedback.issues.slice(0, 5).map((issue, i) => (
                      <div key={i} className="text-xs border-l-2 pl-2 py-1"
                        style={{ borderColor: issue.severity === 'critical' ? '#ef4444' : issue.severity === 'major' ? '#f59e0b' : '#6b7280' }}>
                        <div className="flex items-center gap-1">
                          <StatusBadge status={issue.severity} />
                          <span className="font-medium text-gray-700">{issue.category}</span>
                          <span className="text-gray-400">in {issue.section}</span>
                        </div>
                        <p className="text-gray-600 mt-0.5">{issue.description}</p>
                        {issue.suggestion && <p className="text-gray-400 mt-0.5 italic">→ {issue.suggestion}</p>}
                      </div>
                    ))}
                    {round.criticFeedback.issues.length > 5 && (
                      <p className="text-xs text-gray-400">+{round.criticFeedback.issues.length - 5} more issues</p>
                    )}
                  </div>
                </ExpandableCard>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Inline diff renderer ───────────────────────── */
function DiffText({ segments }: { segments: DiffSegment[] }) {
  return (
    <span>
      {segments.map((seg, i) => (
        <span
          key={i}
          className={
            seg.type === 'add' ? 'bg-green-100 text-green-800 rounded-sm' :
            seg.type === 'remove' ? 'bg-red-100 text-red-800 line-through rounded-sm' :
            ''
          }
        >{seg.text}</span>
      ))}
    </span>
  );
}

/* ─── Source diff renderer ───────────────────────── */
function SourcesDiff({ current, previous, onSourceClick }: { current: Source[]; previous?: Source[]; onSourceClick?: (source: Source) => void }) {
  const prevUrls = new Set(previous?.map(s => s.url) || []);
  const currUrls = new Set(current.map(s => s.url));

  return (
    <div className="mt-1 text-xs space-y-0.5">
      {current.map((s, k) => (
        <button
          key={k}
          className={`text-left w-full hover:underline cursor-pointer transition-colors ${!prevUrls.has(s.url) && previous ? 'text-green-600 font-medium hover:text-green-700' : 'text-gray-500 hover:text-gray-700'}`}
          onClick={() => onSourceClick?.(s)}
          title={s.url}
        >
          📎 {s.directQuote ? `"${s.directQuote.slice(0, 80)}…"` : s.url}
          {!prevUrls.has(s.url) && previous && <span className="ml-1 text-[10px] bg-green-100 text-green-700 px-1 rounded">NEW</span>}
        </button>
      ))}
      {previous?.filter(s => !currUrls.has(s.url)).map((s, k) => (
        <div key={`rem-${k}`} className="text-red-400 line-through">
          📎 {s.url} <span className="text-[10px]">REMOVED</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Draft Preview sub-component with diff support ── */
function DraftPreview({ draft, previousDraft }: { draft: Partial<StagingDraft>; previousDraft?: Partial<StagingDraft> }) {
  const [popupSource, setPopupSource] = React.useState<Source | null>(null);

  return (
    <div className="space-y-4 text-sm">
      {/* Source popup modal */}
      {popupSource && (
        <SourcePopup source={popupSource} onClose={() => setPopupSource(null)} />
      )}

      {/* Bios */}
      {draft.bios && draft.bios.length > 0 && (
        <div>
          <h4 className="font-semibold text-gray-800 mb-2">Biographies</h4>
          {draft.bios.map((bio, i) => {
            const prevBio = previousDraft?.bios?.find(b => b.type === bio.type);
            const isNew = !!previousDraft && !prevBio;
            const changed = !!previousDraft && !!prevBio && textsAreDifferent(prevBio.text, bio.text);

            return (
              <div key={i} className={`mb-3 border-l-2 pl-3 ${isNew ? 'border-green-400 bg-green-50/50' : changed ? 'border-yellow-400 bg-yellow-50/30' : 'border-branch-300'}`}>
                <div className="text-xs text-gray-400 mb-1">
                  {bio.type} · {bio.complete ? 'complete' : 'incomplete'}
                  {isNew && <span className="ml-2 text-green-600 font-medium bg-green-100 px-1 rounded">NEW</span>}
                  {changed && <span className="ml-2 text-yellow-600 font-medium bg-yellow-100 px-1 rounded">CHANGED</span>}
                </div>
                {changed && prevBio ? (
                  <div className="prose prose-sm max-w-none leading-relaxed">
                    <DiffText segments={diffText(prevBio.text || '', bio.text || '')} />
                  </div>
                ) : (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{bio.text || '_No content_'}</ReactMarkdown>
                  </div>
                )}
                {bio.sources?.length > 0 && (
                  <SourcesDiff current={bio.sources} previous={prevBio?.sources} onSourceClick={setPopupSource} />
                )}
              </div>
            );
          })}
          {/* Show removed bios */}
          {previousDraft?.bios?.filter(pb => !draft.bios?.some(b => b.type === pb.type)).map((bio, i) => (
            <div key={`removed-bio-${i}`} className="mb-3 border-l-2 border-red-400 bg-red-50/50 pl-3">
              <div className="text-xs text-red-600 mb-1">{bio.type} · <span className="font-medium">REMOVED</span></div>
              <p className="line-through text-gray-400 text-sm">{bio.text?.slice(0, 200)}{(bio.text?.length ?? 0) > 200 ? '…' : ''}</p>
            </div>
          ))}
        </div>
      )}

      {/* Issues & Stances */}
      {draft.issues && draft.issues.length > 0 && (
        <div>
          <h4 className="font-semibold text-gray-800 mb-2">Issues & Stances</h4>
          {draft.issues.map((issue, i) => {
            const prevIssue = previousDraft?.issues?.find(pi => pi.key === issue.key || pi.title === issue.title);
            const isNewIssue = !!previousDraft && !prevIssue;

            return (
              <ExpandableCard
                key={i}
                title={issue.title || issue.key || `Issue ${i + 1}`}
                badge={
                  <span className="text-xs text-gray-400">
                    {issue.stances?.length || 0} stances
                    {isNewIssue && <span className="ml-1 text-green-600 font-medium bg-green-100 px-1 rounded">NEW</span>}
                  </span>
                }
              >
                {issue.stances?.map((stance, j) => {
                  const prevStance = prevIssue?.stances?.[j];
                  const stanceChanged = !!prevStance && textsAreDifferent(prevStance.text, stance.text);
                  const stanceNew = !!previousDraft && !!prevIssue && !prevStance;

                  return (
                    <div key={j} className={`mb-2 text-xs ${stanceNew ? 'bg-green-50 rounded p-1.5' : stanceChanged ? 'bg-yellow-50 rounded p-1.5' : ''}`}>
                      {stanceNew && <span className="text-[10px] text-green-600 font-medium bg-green-100 px-1 rounded mb-1 inline-block">NEW STANCE</span>}
                      {stanceChanged && <span className="text-[10px] text-yellow-600 font-medium bg-yellow-100 px-1 rounded mb-1 inline-block">CHANGED</span>}
                      {stanceChanged && prevStance ? (
                        <p className="text-gray-700 leading-relaxed">
                          <DiffText segments={diffText(prevStance.text || '', stance.text || '')} />
                        </p>
                      ) : (
                        <p className="text-gray-700">{stance.text}</p>
                      )}
                      {stance.sources && stance.sources.length > 0 && (
                        <SourcesDiff current={stance.sources} previous={prevStance?.sources} onSourceClick={setPopupSource} />
                      )}
                    </div>
                  );
                })}
                {/* Removed stances */}
                {prevIssue && prevIssue.stances && issue.stances && prevIssue.stances.length > issue.stances.length && (
                  prevIssue.stances.slice(issue.stances.length).map((s, j) => (
                    <div key={`rem-s-${j}`} className="mb-2 text-xs bg-red-50 rounded p-1.5">
                      <span className="text-[10px] text-red-600 font-medium bg-red-100 px-1 rounded mb-1 inline-block">REMOVED</span>
                      <p className="text-gray-400 line-through">{s.text?.slice(0, 150)}</p>
                    </div>
                  ))
                )}
              </ExpandableCard>
            );
          })}
          {/* Show removed issues */}
          {previousDraft?.issues?.filter(pi => !draft.issues?.some(di => di.key === pi.key || di.title === pi.title)).map((issue, i) => (
            <div key={`removed-issue-${i}`} className="mb-2 p-3 border-l-2 border-red-400 bg-red-50/50 rounded-r">
              <div className="text-xs text-red-600 font-medium">{issue.title || issue.key} · REMOVED</div>
              <p className="text-xs text-gray-400 line-through mt-1">{issue.stances?.length || 0} stances</p>
            </div>
          ))}
        </div>
      )}

      {/* Sources summary */}
      {(draft.bios?.length || draft.issues?.length) ? (
        <div>
          <h4 className="font-semibold text-gray-800 mb-2">All Sources</h4>
          <div className="space-y-1">
            {(() => {
              const urls = new Set<string>();
              for (const bio of draft.bios || []) {
                for (const s of bio.sources || []) if (s.url) urls.add(s.url);
              }
              for (const issue of draft.issues || []) {
                for (const stance of issue.stances || []) {
                  for (const s of stance.sources || []) if (s.url) urls.add(s.url);
                }
              }
              // Previous round sources for diff
              const prevUrls = new Set<string>();
              if (previousDraft) {
                for (const bio of previousDraft.bios || []) {
                  for (const s of bio.sources || []) if (s.url) prevUrls.add(s.url);
                }
                for (const issue of previousDraft.issues || []) {
                  for (const stance of issue.stances || []) {
                    for (const s of stance.sources || []) if (s.url) prevUrls.add(s.url);
                  }
                }
              }
              const arr = Array.from(urls);
              const removedArr = previousDraft ? Array.from(prevUrls).filter(u => !urls.has(u)) : [];
              return (
                <>
                  {arr.slice(0, 15).map((url, i) => (
                    <div key={i} className={`text-xs ${previousDraft && !prevUrls.has(url) ? 'text-green-600 font-medium' : 'text-gray-600'}`}>
                      {i + 1}. <a href={url} target="_blank" rel="noopener" className="hover:underline">{url}</a>
                      {previousDraft && !prevUrls.has(url) && <span className="ml-1 text-[10px] bg-green-100 text-green-700 px-1 rounded">NEW</span>}
                    </div>
                  ))}
                  {removedArr.map((url, i) => (
                    <div key={`rem-url-${i}`} className="text-xs text-red-400 line-through">
                      − <a href={url} target="_blank" rel="noopener" className="hover:underline">{url}</a>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
