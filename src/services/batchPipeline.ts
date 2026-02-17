/**
 * Batch pipeline — runs a candidate through the full Writer/Critic → Audit flow.
 * Used by the unified Candidates page for "Run All" batch processing.
 */

import type { AIProvider } from './aiProvider';
import type {
  CandidateSession,
  AppSettings,
  BuilderRound,
  AIProviderType,
  ExtractedProfile,
  PipelineMode,
  CriticFeedback,
  ClaimAuditResult,
} from '../types';
import { runWriter } from './agents/writer';
import { runSpecializedCritics, type OrchestratorProviders } from './agents/criticOrchestrator';
import { computeScore } from './scoring';
import { extractClaims } from './audit/claimExtractor';
import { verifyClaim } from './audit/verifier';
import { computeConsensus, buildAuditReport } from './audit/consensus';
import { extractTextFromHtml, extractLinksFromHtml, extractBranchProfile } from './htmlExtractor';
import { extractOutputUrls, extractInputUrls, checkProvenance, formatProvenanceForCritic } from './sourceProvenance';
import { validateAllUrls } from './urlValidator';

// ============================================================================
// Types
// ============================================================================

export interface PipelineCallbacks {
  onStatusChange: (status: string) => void;
  onLog: (message: string) => void;
  onSessionUpdate: (session: CandidateSession) => void;
}

export interface PipelineProviders {
  getProvider: (type: AIProviderType, model?: string) => Promise<AIProvider>;
}

export interface PipelineInput {
  session: CandidateSession;
  /** If set, skip writer/critic — this candidate already has a profile to audit */
  importedHtml?: string;
  extractedProfile?: ExtractedProfile | null;
}

// ============================================================================
// Pipeline
// ============================================================================

/**
 * Process one candidate through the full pipeline:
 *   1. (HTML import only) Parse HTML, store profile on session
 *   2. Writer/Critic adversarial loop → converged draft
 *   3. Audit — claim extraction + multi-verifier verification
 *
 * Returns the updated session.
 */
export async function runCandidatePipeline(
  input: PipelineInput,
  settings: AppSettings,
  providers: PipelineProviders,
  callbacks: PipelineCallbacks,
): Promise<CandidateSession> {
  let currentSession = { ...input.session };

  // ────────────────────────────────────────────────────
  // Step 0: If HTML import, parse and attach profile
  // ────────────────────────────────────────────────────
  if (input.importedHtml) {
    callbacks.onLog(`Parsing imported HTML for ${currentSession.candidateName}…`);

    const profile = input.extractedProfile ?? extractBranchProfile(input.importedHtml);
    const links = extractLinksFromHtml(input.importedHtml);

    currentSession = {
      ...currentSession,
      importedHtml: input.importedHtml,
      extractedProfile: profile,
      additionalSources: links
        .filter(l => l.url)
        .map(l => ({
          url: l.url,
          title: l.title || l.url,
          addedAt: new Date().toISOString(),
        })),
    };
    callbacks.onSessionUpdate(currentSession);
  }

  // ────────────────────────────────────────────────────
  // Step 1: Writer / Critic adversarial loop
  // ────────────────────────────────────────────────────
  callbacks.onStatusChange('building');
  callbacks.onLog(`Starting Writer/Critic loop for ${currentSession.candidateName}…`);

  const pipelineMode: PipelineMode = settings.pipelineMode ?? 'balanced';

  // Pipeline mode determines max rounds and whether critics/audit run
  const effectiveMaxRounds = pipelineMode === 'thorough' ? (settings.maxAdversarialRounds || 3)
    : pipelineMode === 'balanced' ? Math.min(settings.maxAdversarialRounds || 3, 2)
    : 1; // fast & draft = 1 round

  const skipCritics = pipelineMode === 'draft';
  const skipAudit = pipelineMode === 'draft';

  callbacks.onLog(`Pipeline mode: ${pipelineMode} (max ${effectiveMaxRounds} round${effectiveMaxRounds > 1 ? 's' : ''}${skipCritics ? ', no critics' : ''}${skipAudit ? ', no audit' : ''})`);

  const maxRounds = effectiveMaxRounds;

  for (let round = currentSession.builderRounds.length + 1; round <= currentSession.builderRounds.length + maxRounds; round++) {
    // --- Writer ---
    callbacks.onLog(`Round ${round}: Writer generating draft…`);
    const writerRole = settings.roleAssignments?.writer || { provider: 'gemini-free' as AIProviderType };
    const writerProvider = await providers.getProvider(writerRole.provider, writerRole.model);

    const previousFeedback = currentSession.builderRounds.length > 0
      ? currentSession.builderRounds[currentSession.builderRounds.length - 1].criticFeedback
      : undefined;

    const extractedText = currentSession.extractedProfile
      ? JSON.stringify(currentSession.extractedProfile)
      : '';
    const additionalSourcesText = currentSession.additionalSources
      .map(s => `- ${s.title}: ${s.url}`).join('\n');
    const sourceContext = [extractedText, additionalSourcesText].filter(Boolean).join('\n\n');

    const draft = await runWriter(writerProvider, {
      candidateName: currentSession.candidateName,
      sourceContent: sourceContext,
      previousDraft: currentSession.currentDraft ?? undefined,
      criticFeedback: previousFeedback ?? undefined,
    });

    // --- Source Provenance Check (deterministic, no AI) ---
    const outputUrls = extractOutputUrls(draft as Record<string, unknown>);
    const inputUrls = extractInputUrls(sourceContext);
    const provenance = checkProvenance(outputUrls, inputUrls);
    let provenanceContext: string | undefined;

    if (provenance.fabricated > 0) {
      callbacks.onLog(`⚠ Source provenance: ${provenance.fabricated}/${provenance.totalUrls} URLs not in source material`);
      provenanceContext = formatProvenanceForCritic(provenance);
      // Store provenance summary on session
      currentSession = {
        ...currentSession,
        provenanceSummary: {
          totalUrls: provenance.totalUrls,
          fromInput: provenance.fromInput,
          fabricated: provenance.fabricated,
          fabricatedUrls: provenance.results.filter(r => !r.isFromInput).map(r => r.url),
        },
      };
    } else if (provenance.totalUrls > 0) {
      callbacks.onLog(`✅ Source provenance: all ${provenance.totalUrls} URLs found in source material`);
      provenanceContext = formatProvenanceForCritic(provenance);
      currentSession = {
        ...currentSession,
        provenanceSummary: {
          totalUrls: provenance.totalUrls,
          fromInput: provenance.fromInput,
          fabricated: 0,
          fabricatedUrls: [],
        },
      };
    }

    // --- Critic ---
    let feedback: CriticFeedback;
    let converged = false;

    if (skipCritics) {
      // Draft mode — no critics, just save the draft
      feedback = {
        issues: [],
        overallAssessment: 'Draft mode — no critic review performed.',
        overallScore: 100,
        templateComplianceScore: 100,
      };
      converged = true;
    } else {
      const criticLabel = (settings.criticMode ?? 'combined') === 'combined' ? 'Combined critic' : 'Specialized critics';
      callbacks.onLog(`Round ${round}: ${criticLabel} reviewing…`);
      const fcRole = settings.roleAssignments?.factChecker || settings.roleAssignments?.critic || { provider: 'gemini-free' as AIProviderType };
      const lrRole = settings.roleAssignments?.languageReviewer || settings.roleAssignments?.critic || { provider: 'gemini-free' as AIProviderType };
      const saRole = settings.roleAssignments?.styleAuditor || settings.roleAssignments?.critic || { provider: 'gemini-free' as AIProviderType };

      const criticProviders: OrchestratorProviders = {
        factChecker: await providers.getProvider(fcRole.provider, fcRole.model),
        languageReviewer: await providers.getProvider(lrRole.provider, lrRole.model),
        styleAuditor: await providers.getProvider(saRole.provider, saRole.model),
      };

      const { merged } = await runSpecializedCritics(
        criticProviders,
        { candidateName: currentSession.candidateName, draft, sourceContent: sourceContext, provenanceContext },
        settings,
        {
          onAgentStart: (agent, pass, total) => {
            const passLabel = total > 1 ? ` (pass ${pass}/${total})` : '';
            callbacks.onLog(`  ▶ ${agent}${passLabel}…`);
          },
          onAgentComplete: (agent, _pass, af) => {
            const agentScore = computeScore(af.issues);
            callbacks.onLog(`  ✓ ${agent}: score ${agentScore}/100, ${af.issues.length} issues`);
          },
          onAgentRetry: (agent, attempt, maxAttempts, errMsg, delaySec) => {
            if (delaySec > 0) {
              callbacks.onLog(`  ⚠ ${agent} retry ${attempt}/${maxAttempts}: ${errMsg}`);
            } else {
              callbacks.onLog(`  ✗ ${agent} failed permanently after ${maxAttempts} attempts`);
            }
          },
        },
      );
      feedback = merged;

      converged = feedback.overallScore >= (settings.convergenceThreshold || 80)
        && feedback.issues.filter(i => i.severity === 'critical').length === 0
        && feedback.issues.filter(i => i.severity === 'major').length === 0
        && (feedback.failedAgents?.length ?? 0) === 0;
    }

    const builderRound: BuilderRound = {
      roundNumber: round,
      writerOutput: draft,
      criticFeedback: feedback,
      timestamp: new Date().toISOString(),
    };

    currentSession = {
      ...currentSession,
      currentDraft: draft,
      builderRounds: [...currentSession.builderRounds, builderRound],
      status: 'building',
    };
    callbacks.onSessionUpdate(currentSession);

    const criticalCount = feedback.issues.filter(i => i.severity === 'critical').length;
    const majorCount = feedback.issues.filter(i => i.severity === 'major').length;
    const fabricationCount = feedback.issues.filter(i => i.severity === 'fabrication').length;
    const failedAgentCount = feedback.failedAgents?.length ?? 0;
    callbacks.onLog(`Round ${round}: Score ${feedback.overallScore}/100${fabricationCount ? `, ${fabricationCount} fabrication(s)` : ''}, ${criticalCount} critical, ${majorCount} major${failedAgentCount ? `, ${failedAgentCount} agent(s) failed` : ''}`);

    if (converged) {
      // Don't converge if there are fabricated sources
      if (fabricationCount > 0) {
        callbacks.onLog(`⚠ Fabricated sources detected — continuing despite high score`);
      } else {
        callbacks.onLog(`✅ Converged at round ${round}!`);
        break;
      }
    }
  }

  currentSession = { ...currentSession, status: 'ready-for-audit' };
  callbacks.onSessionUpdate(currentSession);

  // ────────────────────────────────────────────────────
  // Step 2: Audit — claim extraction + verification
  // ────────────────────────────────────────────────────
  const auditMode = settings.auditMode ?? 'single-verifier';
  if (currentSession.currentDraft && !skipAudit && auditMode !== 'skip') {
    callbacks.onStatusChange('auditing');
    callbacks.onLog(`Running audit for ${currentSession.candidateName}…`);

    // Extract claims
    const extractorRole = settings.roleAssignments?.extractor || { provider: 'gemini-free' as AIProviderType };
    const extractorProvider = await providers.getProvider(extractorRole.provider, extractorRole.model);
    const claims = await extractClaims(extractorProvider, currentSession.currentDraft, currentSession.candidateName);
    callbacks.onLog(`Extracted ${claims.length} verifiable claims`);

    // Verify each claim — respect audit mode
    const allVerifierRoles = settings.roleAssignments?.verifiers || [{ provider: 'gemini-free' as AIProviderType }];
    const verifierRoles = auditMode === 'single-verifier' ? allVerifierRoles.slice(0, 1) : allVerifierRoles;
    const auditResults: ClaimAuditResult[] = [];

    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      callbacks.onLog(`Verifying claim ${i + 1}/${claims.length}: "${claim.text.slice(0, 50)}…"`);

      const verifierResults = [];
      for (const role of verifierRoles) {
        try {
          const provider = await providers.getProvider(role.provider, role.model);
          const result = await verifyClaim(provider, claim, currentSession.candidateName);
          verifierResults.push(result);
        } catch (err: any) {
          callbacks.onLog(`  ⚠ Verifier ${role.provider} failed: ${err.message}`);
        }
      }

      const consensus = computeConsensus(verifierResults);
      const identityMismatch = verifierResults.some(v => v.identityMismatch);
      auditResults.push({
        claim,
        verifierResults,
        consensus: consensus.verdict,
        confidence: consensus.confidence,
        explanation: consensus.explanation,
        identityMismatch,
        needsHumanReview: identityMismatch || consensus.verdict === 'no-consensus',
      });
    }

    // URL validation — check if cited URLs actually respond
    const claimUrls = claims
      .map(c => c.sourceUrl)
      .filter(u => u && u.startsWith('http'));
    const uniqueUrls = [...new Set(claimUrls)];

    if (uniqueUrls.length > 0) {
      callbacks.onLog(`Validating ${uniqueUrls.length} cited URLs…`);
      // Build a quote map for quote checking
      const quoteMap = new Map<string, string>();
      for (const claim of claims) {
        if (claim.sourceUrl && claim.supportingQuote) {
          quoteMap.set(claim.sourceUrl, claim.supportingQuote);
        }
      }
      try {
        const urlResults = await validateAllUrls(uniqueUrls, quoteMap, 5, 10000);
        const valid = urlResults.filter(r => r.status === 'valid').length;
        const invalid = urlResults.filter(r => r.status === 'invalid').length;
        const unverifiable = urlResults.filter(r => r.status === 'unverifiable').length;
        const quotesFound = urlResults.filter(r => r.quoteFound === true).length;
        const quotesChecked = urlResults.filter(r => r.quoteFound !== undefined).length;

        callbacks.onLog(
          `URL validation: ${valid} valid, ${invalid} invalid, ${unverifiable} unverifiable` +
          (quotesChecked > 0 ? ` · ${quotesFound}/${quotesChecked} quotes found on page` : '')
        );

        // Attach URL validation results to matching audit results
        for (const ar of auditResults) {
          const urlResult = urlResults.find(r => r.url === ar.claim.sourceUrl);
          if (urlResult) {
            ar.urlValidation = {
              exists: urlResult.status === 'valid',
              quoteFound: urlResult.quoteFound ?? false,
              method: urlResult.method,
              status: urlResult.status,
            };
          }
        }
      } catch (err: any) {
        callbacks.onLog(`⚠ URL validation failed: ${err.message}`);
      }
    }

    const auditReport = buildAuditReport(auditResults, currentSession.candidateName);

    currentSession = {
      ...currentSession,
      auditReports: [...(currentSession.auditReports || []), auditReport],
      status: 'audited',
    };
    callbacks.onSessionUpdate(currentSession);

    callbacks.onLog(
      `✅ Audit complete: ${auditReport.summary.verified} verified, ` +
      `${auditReport.summary.contradicted} contradicted, ` +
      `${auditReport.summary.unverified} unverified`
    );
  }

  return currentSession;
}
