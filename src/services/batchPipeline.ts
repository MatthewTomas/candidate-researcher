/**
 * Batch pipeline — runs a candidate through the full Writer/Critic → Source Verification flow.
 * Used by the unified Candidates page for "Run All" batch processing.
 */

import type { AIProvider, TrackedProviderOptions } from './aiProvider';
import type {
  CandidateSession,
  AppSettings,
  BuilderRound,
  AIProviderType,
  ExtractedProfile,
  PipelineMode,
  CriticFeedback,
  LinkItem,
} from '../types';
import { AI_PROVIDERS } from '../types';
import { runWriter } from './agents/writer';
import { runSpecializedCritics, type OrchestratorProviders } from './agents/criticOrchestrator';
import { computeScore } from './scoring';
import { extractTextFromHtml, extractLinksFromHtml, extractBranchProfile } from './htmlExtractor';
import { extractOutputUrls, extractInputUrls, checkProvenance, formatProvenanceForCritic } from './sourceProvenance';
import { researchCandidate, formatResearchAsSourceContent, type FetchedPage } from './webResearch';
import { verifyDraftSources } from './sourceVerifier';
import { getCallLog } from './costTracker';

// ============================================================================
// Types
// ============================================================================

/** Extract social media links from research pages by URL pattern matching */
function extractSocialLinksFromPages(pages: FetchedPage[]): LinkItem[] {
  const SOCIAL_PATTERNS: { pattern: RegExp; mediaType: LinkItem['mediaType'] }[] = [
    { pattern: /facebook\.com\/[\w.]+/i, mediaType: 'facebook' },
    { pattern: /(?:twitter|x)\.com\/\w+/i, mediaType: 'twitter' },
    { pattern: /instagram\.com\/\w+/i, mediaType: 'instagram' },
    { pattern: /youtube\.com\/(?:@|channel\/|c\/)[\w-]+/i, mediaType: 'youtube' },
    { pattern: /linkedin\.com\/in\/[\w-]+/i, mediaType: 'linkedin' },
    { pattern: /tiktok\.com\/@[\w.]+/i, mediaType: 'tiktok' },
  ];
  const found = new Map<string, LinkItem>();
  for (const page of pages) {
    if (page.error) continue;
    // Check if the page URL itself is a social media profile
    for (const { pattern, mediaType } of SOCIAL_PATTERNS) {
      if (pattern.test(page.url) && !found.has(mediaType)) {
        found.set(mediaType, {
          mediaType,
          url: page.url,
          title: page.title || mediaType,
          confidence: 'high',
        });
      }
    }
    // Also scan page text for social media URLs
    const urlMatches = page.text.match(/https?:\/\/[^\s"'<>]+/g) || [];
    for (const urlStr of urlMatches) {
      for (const { pattern, mediaType } of SOCIAL_PATTERNS) {
        if (pattern.test(urlStr) && !found.has(mediaType)) {
          found.set(mediaType, {
            mediaType,
            url: urlStr.replace(/[)\].,]+$/, ''), // clean trailing punctuation
            title: mediaType,
            confidence: 'medium',
          });
        }
      }
    }
  }
  return [...found.values()];
}

export interface PipelineCallbacks {
  onStatusChange: (status: string) => void;
  onLog: (message: string) => void;
  onSessionUpdate: (session: CandidateSession) => void;
}

export interface PipelineProviders {
  getProvider: (type: AIProviderType, model?: string) => Promise<AIProvider>;
  /** Get a provider wrapped with cost tracking */
  getTrackedProvider?: (type: AIProviderType, opts: TrackedProviderOptions, model?: string) => Promise<AIProvider>;
}

export interface PipelineInput {
  session: CandidateSession;
  /** If set, skip writer/critic — this candidate already has a profile to audit */
  importedHtml?: string;
  extractedProfile?: ExtractedProfile | null;
  /** User-provided source URLs to seed the research phase */
  sourceUrls?: string[];
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

  // ── Helper: get a tracked provider (falls back to untracked if not available) ──
  // Also resolves gemini-free → gemini-paid when the user is on a paid tier
  const resolveProvider = async (type: AIProviderType, role: string, model?: string): Promise<AIProvider> => {
    // Auto-switch gemini-free to gemini-paid when user is on a paid tier
    let resolvedType = type;
    if (type === 'gemini-free' && settings.geminiTier && settings.geminiTier !== 'free') {
      resolvedType = 'gemini-paid' as AIProviderType;
    }
    if (providers.getTrackedProvider) {
      return providers.getTrackedProvider(
        resolvedType,
        { role, sessionId: currentSession.id, candidateName: currentSession.candidateName },
        model,
      );
    }
    return providers.getProvider(resolvedType, model);
  };

  /** Build a human-readable label like "gemini-2.5-flash via Gemini (Free)" */
  const describeRole = (providerType: AIProviderType, model?: string): string => {
    let resolvedType = providerType;
    if (providerType === 'gemini-free' && settings.geminiTier && settings.geminiTier !== 'free') {
      resolvedType = 'gemini-paid' as AIProviderType;
    }
    const cfg = AI_PROVIDERS[resolvedType];
    const modelName = model || cfg?.defaultModel || resolvedType;
    const providerName = cfg?.name || resolvedType;
    return `${modelName} via ${providerName}`;
  };

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

  // ────────────────────────────────────────────────────  // Step 0.5: Web Research (when no imported HTML)
  // Search the web, fetch candidate pages, build source material
  // ────────────────────────────────────────────────
  let insufficientData = false;

  if (!input.importedHtml) {
    callbacks.onStatusChange('researching');
    callbacks.onLog(`Starting web research for ${currentSession.candidateName}…`);

    let searchFailed = false;
    const researchStart = Date.now();

    try {
      const researchResult = await researchCandidate(
        currentSession.candidateName,
        (currentSession as any).metadata || undefined,
        settings,
        input.sourceUrls || [],
        callbacks.onLog,
      );

      searchFailed = researchResult.searchFailure === true;

      // Store fetched URLs as additionalSources on the session
      const fetchedSources = researchResult.pages
        .filter(p => !p.error && p.text.length > 50)
        .map(p => ({
          url: p.url,
          title: p.title,
          addedAt: p.fetchedAt,
        }));

      currentSession = {
        ...currentSession,
        additionalSources: [
          ...currentSession.additionalSources,
          ...fetchedSources,
        ],
      };

      // Build the source content from research results
      const researchContent = formatResearchAsSourceContent(researchResult);
      // Attach to session for the Writer to consume
      (currentSession as any)._researchContent = researchContent;

      // Extract social media links from fetched URLs
      const rawSocialLinks = extractSocialLinksFromPages(researchResult.pages);
      if (rawSocialLinks.length > 0) {
        callbacks.onLog(`Found ${rawSocialLinks.length} social media link(s) from research — validating identity…`);

        // AI-based social link identity validation
        let socialLinks = rawSocialLinks;
        try {
          const writerRole = settings.roleAssignments?.writer || { provider: 'gemini-free' as AIProviderType };
          const validationProvider = await resolveProvider(writerRole.provider, 'socialValidator', writerRole.model);

          // Build context from page content for each link
          const linkContexts = rawSocialLinks.map(link => {
            const page = researchResult.pages.find(p => p.url === link.url || p.text.includes(link.url));
            const snippet = page ? page.text.slice(0, 500) : '';
            return { url: link.url, mediaType: link.mediaType, pageSnippet: snippet };
          });

          const validationPrompt = `You are verifying whether social media URLs belong to a specific political candidate.

Candidate: ${currentSession.candidateName}
${(currentSession as any).metadata?.state ? `State: ${(currentSession as any).metadata.state}` : ''}
${(currentSession as any).metadata?.office ? `Office: ${(currentSession as any).metadata.office}` : ''}
${(currentSession as any).metadata?.party ? `Party: ${(currentSession as any).metadata.party}` : ''}

For each URL below, determine if it belongs to THIS specific candidate (not someone else with the same name).

URLs to validate:
${linkContexts.map((lc, i) => `${i + 1}. [${lc.mediaType}] ${lc.url}\n   Page content preview: "${lc.pageSnippet.slice(0, 300)}"`).join('\n')}

Respond with a JSON array where each element has:
- "index": the 1-based index
- "verdict": "confirmed" | "wrong_person" | "uncertain"
- "reason": brief explanation (1 sentence)

ONLY output the JSON array, no other text.`;

          const validationResult = await validationProvider.generateText(validationPrompt, { jsonMode: true });
          const parsed = JSON.parse(validationResult.replace(/```json?\s*/g, '').replace(/```/g, '').trim());

          if (Array.isArray(parsed)) {
            const confirmed: LinkItem[] = [];
            const discarded: string[] = [];
            const uncertain: LinkItem[] = [];

            for (const item of parsed) {
              const idx = (item.index ?? 0) - 1;
              if (idx < 0 || idx >= rawSocialLinks.length) continue;
              const link = rawSocialLinks[idx];

              if (item.verdict === 'wrong_person') {
                discarded.push(`${link.mediaType}: ${link.url} (${item.reason || 'wrong person'})`);
              } else if (item.verdict === 'uncertain') {
                uncertain.push({ ...link, confidence: 'low' });
              } else {
                confirmed.push({ ...link, confidence: 'high' });
              }
            }

            socialLinks = [...confirmed, ...uncertain];
            if (discarded.length > 0) {
              for (const d of discarded) callbacks.onLog(`  🚫 Discarded: ${d}`);
            }
            callbacks.onLog(`🔗 Social links: ${confirmed.length} confirmed, ${discarded.length} discarded (wrong person), ${uncertain.length} uncertain`);
          }
        } catch (err: any) {
          callbacks.onLog(`⚠ Social link validation failed (keeping all): ${err.message}`);
          // Fall through with unvalidated links
        }

        // Store validated links for merging into draft after Writer produces one
        (currentSession as any)._discoveredSocialLinks = socialLinks;
      }

      // Log source quality summary
      const successPages = researchResult.pages.filter(p => !p.error && p.text.length > 50);
      const failedPages = researchResult.pages.filter(p => p.error || p.text.length <= 50);
      const sourceTypes: Record<string, number> = {};
      for (const p of successPages) {
        const domain = (() => {
          try { return new URL(p.url).hostname.replace('www.', ''); } catch { return 'unknown'; }
        })();
        const type =
          /ballotpedia|votesmart|opensecrets/.test(domain) ? 'reference' :
          /facebook|instagram|twitter|x\.com|linkedin|youtube|tiktok/.test(domain) ? 'social' :
          domain.endsWith('.gov') ? '.gov' :
          /news|times|post|tribune|herald|gazette|observer|journal|press|nbc|cbs|abc|fox|cnn|npr|pbs|reuters|ap/.test(domain) ? 'news' :
          /\.com$|\.org$|\.net$/.test(domain) ? 'website' : 'other';
        sourceTypes[type] = (sourceTypes[type] || 0) + 1;
      }
      const srcSummary = Object.entries(sourceTypes).map(([t, n]) => `${n} ${t}`).join(', ');
      const researchDuration = ((Date.now() - researchStart) / 1000).toFixed(1);
      callbacks.onLog(`📊 Research: ${successPages.length} sources (${srcSummary}), ${failedPages.length} failed — ${researchDuration}s`);

      callbacks.onSessionUpdate(currentSession);
    } catch (err: any) {
      callbacks.onLog(`⚠ Research phase failed: ${err.message}. Proceeding with limited data.`);
      searchFailed = true;
    }

    // If all searches returned 0 results and we have no source material,
    // produce a minimal 1-round draft with no critics instead of burning rounds at 0/100
    if (searchFailed && currentSession.additionalSources.length === 0) {
      callbacks.onLog(`⚠ No source material found. Running 1-round minimal draft (no critics).`);
      insufficientData = true;
    }
  }

  // ────────────────────────────────────────────────  // Step 1: Writer / Critic adversarial loop
  // ────────────────────────────────────────────────────
  callbacks.onStatusChange('building');
  callbacks.onLog(`Starting Writer/Critic loop for ${currentSession.candidateName}…`);

  const pipelineMode: PipelineMode = settings.pipelineMode ?? 'balanced';

  // Use user-configured max rounds directly
  const effectiveMaxRounds = settings.maxAdversarialRounds || 3;

  let skipCritics = settings.skipCritics ?? false;

  // Override to 1-round minimal draft when research found nothing
  let maxRounds = effectiveMaxRounds;
  if (insufficientData) {
    maxRounds = 1;
    skipCritics = true;
  }

  callbacks.onLog(`Pipeline: max ${maxRounds} round${maxRounds > 1 ? 's' : ''}${skipCritics ? ', no critics' : ''}`);

  // Stall detection — stop early when score isn't improving
  let lastScore = -1;
  let stallCount = 0;
  const pipelineStart = Date.now();

  for (let round = currentSession.builderRounds.length + 1; round <= currentSession.builderRounds.length + maxRounds; round++) {
    // --- Writer ---
    const writerRole = settings.roleAssignments?.writer || { provider: 'gemini-free' as AIProviderType };
    callbacks.onLog(`Round ${round}: Writer generating draft (${describeRole(writerRole.provider, writerRole.model)})…`);
    const writerProvider = await resolveProvider(writerRole.provider, 'writer', writerRole.model);
    const writerStart = Date.now();

    const previousFeedback = currentSession.builderRounds.length > 0
      ? currentSession.builderRounds[currentSession.builderRounds.length - 1].criticFeedback
      : undefined;

    const extractedText = currentSession.extractedProfile
      ? JSON.stringify(currentSession.extractedProfile)
      : '';
    const additionalSourcesText = currentSession.additionalSources
      .map(s => `- ${s.title}: ${s.url}`).join('\n');
    // Include web research content if available
    const researchContent = (currentSession as any)._researchContent || '';
    const sourceContext = [researchContent, extractedText, additionalSourcesText].filter(Boolean).join('\n\n');

    const draft = await (async () => {
      const WRITER_MAX_RETRIES = 2;
      for (let attempt = 1; attempt <= WRITER_MAX_RETRIES + 1; attempt++) {
        try {
          return await runWriter(writerProvider, {
            candidateName: currentSession.candidateName,
            sourceContent: sourceContext,
            previousDraft: currentSession.currentDraft ?? undefined,
            criticFeedback: previousFeedback ?? undefined,
          });
        } catch (err: any) {
          const msg = (err.message || '').toLowerCase();
          const isRetryable = /503|unavailable|overloaded|429|quota|rate.?limit|timeout|econnreset|network/i.test(msg);
          if (isRetryable && attempt <= WRITER_MAX_RETRIES) {
            const delay = attempt * 5;
            callbacks.onLog(`  ⚠ Writer error (attempt ${attempt}/${WRITER_MAX_RETRIES + 1}): ${err.message} — retrying in ${delay}s`);
            await new Promise(r => setTimeout(r, delay * 1000));
          } else {
            throw err;
          }
        }
      }
      throw new Error('Writer failed after all retries');
    })();
    const writerDuration = ((Date.now() - writerStart) / 1000).toFixed(1);
    callbacks.onLog(`Round ${round}: Writer took ${writerDuration}s`);

    // Log URLs the Writer cited in the draft
    const draftCitedUrls = extractOutputUrls(draft as Record<string, unknown>);
    if (draftCitedUrls.length > 0) {
      callbacks.onLog(`Round ${round}: Writer cited ${draftCitedUrls.length} URL(s):`);
      for (const url of draftCitedUrls) {
        callbacks.onLog(`  📎 Writer cited: ${url}`);
      }
    }

    // --- Source Provenance Check (deterministic, no AI) ---
    const outputUrls = extractOutputUrls(draft as Record<string, unknown>);
    const inputUrls = extractInputUrls(sourceContext);

    // Log which source URLs are being used as research input
    if (inputUrls.length > 0) {
      callbacks.onLog(`Round ${round}: Researching ${inputUrls.length} source URL(s):`);
      for (const url of inputUrls) {
        callbacks.onLog(`  🌐 Researching source: ${url}`);
      }
    }

    const provenance = checkProvenance(outputUrls, inputUrls);
    let provenanceContext: string | undefined;

    if (provenance.fabricated > 0) {
      callbacks.onLog(`⚠ Source provenance: ${provenance.fabricated}/${provenance.totalUrls} URLs not in source material`);
      for (const r of provenance.results.filter(r => !r.isFromInput)) {
        callbacks.onLog(`  🚩 Fabricated URL flagged: ${r.url}`);
      }
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
      const fcRole = settings.roleAssignments?.factChecker || settings.roleAssignments?.critic || { provider: 'gemini-free' as AIProviderType };
      const lrRole = settings.roleAssignments?.languageReviewer || settings.roleAssignments?.critic || { provider: 'gemini-free' as AIProviderType };
      const saRole = settings.roleAssignments?.styleAuditor || settings.roleAssignments?.critic || { provider: 'gemini-free' as AIProviderType };
      callbacks.onLog(`Round ${round}: ${criticLabel} reviewing (FC: ${describeRole(fcRole.provider, fcRole.model)}, LR: ${describeRole(lrRole.provider, lrRole.model)}, SA: ${describeRole(saRole.provider, saRole.model)})…`);
      const criticStart = Date.now();

      const criticProviders: OrchestratorProviders = {
        factChecker: await resolveProvider(fcRole.provider, 'factChecker', fcRole.model),
        languageReviewer: await resolveProvider(lrRole.provider, 'languageReviewer', lrRole.model),
        styleAuditor: await resolveProvider(saRole.provider, 'styleAuditor', saRole.model),
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
      const criticDuration = ((Date.now() - criticStart) / 1000).toFixed(1);
      callbacks.onLog(`Round ${round}: Critic took ${criticDuration}s`);

      // Converge when quality thresholds are met.
      // Failed agents are NOT a convergence blocker — a degraded provider (503, rate-limit)
      // should not force extra rounds when the draft already meets the quality bar.
      // A separate log warning is emitted below when agents did fail.
      converged = feedback.overallScore >= (settings.convergenceThreshold || 80)
        && feedback.issues.filter(i => i.severity === 'critical').length === 0
        && feedback.issues.filter(i => i.severity === 'major').length === 0;

      if (converged && (feedback.failedAgents?.length ?? 0) > 0) {
        callbacks.onLog(`⚠ ${feedback.failedAgents!.length} critic agent(s) failed (${feedback.failedAgents!.join(', ')}) but quality threshold met — converging anyway. Review manually.`);
      }
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

    // Merge discovered social links into the draft (first round only)
    const discoveredLinks = (currentSession as any)._discoveredSocialLinks as LinkItem[] | undefined;
    if (discoveredLinks?.length && currentSession.currentDraft) {
      const existingUrls = new Set((currentSession.currentDraft.links || []).map(l => l.url));
      const newLinks = discoveredLinks.filter(sl => !existingUrls.has(sl.url));
      if (newLinks.length > 0) {
        currentSession = {
          ...currentSession,
          currentDraft: {
            ...currentSession.currentDraft,
            links: [...(currentSession.currentDraft.links || []), ...newLinks],
          },
        };
      }
      delete (currentSession as any)._discoveredSocialLinks;
    }

    callbacks.onSessionUpdate(currentSession);

    const criticalCount = feedback.issues.filter(i => i.severity === 'critical').length;
    const majorCount = feedback.issues.filter(i => i.severity === 'major').length;
    const fabricationCount = feedback.issues.filter(i => i.severity === 'fabrication').length;
    const failedAgentCount = feedback.failedAgents?.length ?? 0;
    const scoreDelta = lastScore >= 0 ? ` (${feedback.overallScore >= lastScore ? '+' : ''}${feedback.overallScore - lastScore})` : '';
    callbacks.onLog(`Round ${round}: Score ${feedback.overallScore}/100${scoreDelta}${fabricationCount ? `, ${fabricationCount} fabrication(s)` : ''}, ${criticalCount} critical, ${majorCount} major${failedAgentCount ? `, ${failedAgentCount} agent(s) failed` : ''}`);

    // Log issue category breakdown
    if (feedback.issues.length > 0) {
      const byCat: Record<string, number> = {};
      for (const issue of feedback.issues) {
        const cat = issue.category || issue.severity;
        byCat[cat] = (byCat[cat] || 0) + 1;
      }
      const catSummary = Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `${count} ${cat}`)
        .join(', ');
      callbacks.onLog(`  Issues: ${catSummary}`);

      // Top 5 highest-severity issues
      const severityOrder: Record<string, number> = { fabrication: 0, critical: 1, major: 2, minor: 3, suggestion: 4 };
      const sorted = [...feedback.issues].sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));
      const top5 = sorted.slice(0, 5);
      for (let idx = 0; idx < top5.length; idx++) {
        const issue = top5[idx];
        callbacks.onLog(`  [${idx + 1}] [${issue.severity}] ${issue.category || ''}: ${(issue.description || '').slice(0, 120)}`);
      }
    }

    // Stall detection — if score hasn't improved for 2 consecutive rounds, stop
    if (feedback.overallScore <= lastScore) {
      stallCount++;
    } else {
      stallCount = 0;
    }
    lastScore = feedback.overallScore;

    if (stallCount >= 2 && feedback.overallScore < (settings.convergenceThreshold || 80)) {
      callbacks.onLog(`⚠ Score stalled at ${feedback.overallScore}/100 for ${stallCount} rounds — stopping early to save resources`);
      break;
    }

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

  // Convergence summary
  {
    const threshold = settings.convergenceThreshold || 80;
    const lastRound = currentSession.builderRounds?.[currentSession.builderRounds.length - 1];
    const finalScore = lastRound?.criticFeedback?.overallScore ?? lastScore;
    if (finalScore < threshold) {
      const lastFeedback = lastRound?.criticFeedback;
      const crit = lastFeedback?.issues.filter(i => i.severity === 'critical').length ?? 0;
      const maj = lastFeedback?.issues.filter(i => i.severity === 'major').length ?? 0;
      const fab = lastFeedback?.issues.filter(i => i.severity === 'fabrication').length ?? 0;
      const failed = lastFeedback?.failedAgents?.length ?? 0;
      const reasons: string[] = [];
      if (finalScore < threshold) reasons.push(`score ${finalScore} < ${threshold}`);
      if (crit > 0) reasons.push(`${crit} critical`);
      if (maj > 0) reasons.push(`${maj} major`);
      if (fab > 0) reasons.push(`${fab} fabrication`);
      if (failed > 0) reasons.push(`${failed} failed agent(s)`);
      callbacks.onLog(`⚠ Did not converge: ${reasons.join(', ')}`);
    }
  }

  // Tag the draft with a data warning when research failed
  if (insufficientData && currentSession.currentDraft) {
    currentSession = {
      ...currentSession,
      currentDraft: {
        ...currentSession.currentDraft,
        dataWarning: 'insufficient-sources',
      },
    };
  }

  // Mark draft status complete so exported JSON reflects it
  if (currentSession.currentDraft) {
    currentSession = {
      ...currentSession,
      currentDraft: {
        ...currentSession.currentDraft,
        status: 'complete',
      },
    };
  }
  currentSession = { ...currentSession, status: 'complete' };
  callbacks.onSessionUpdate(currentSession);

  // ────────────────────────────────────────────────────
  // Step 1.5: Source verification — fetch cited URLs & AI-verify quotes
  // ────────────────────────────────────────────────────
  const verifyStart = Date.now();
  if (currentSession.currentDraft) {
    try {
      const verifierRole = settings.roleAssignments?.verifiers?.[0] || { provider: 'gemini-free' as AIProviderType };
      callbacks.onLog(`Verifying cited sources for ${currentSession.candidateName} (${describeRole(verifierRole.provider, verifierRole.model)})…`);
      const verifierProvider = await resolveProvider(verifierRole.provider, 'sourceVerifier', verifierRole.model);
      const verifyResult = await verifyDraftSources(
        verifierProvider,
        currentSession.currentDraft,
        currentSession.candidateName,
        (msg) => callbacks.onLog(msg),
      );
      currentSession = {
        ...currentSession,
        currentDraft: verifyResult.draft,
      };
      callbacks.onSessionUpdate(currentSession);
      const verifyDuration = ((Date.now() - verifyStart) / 1000).toFixed(1);
      callbacks.onLog(
        `Source verification complete: ${verifyResult.verified}/${verifyResult.totalSources} verified, ` +
        `${verifyResult.lowConfidence} low-confidence — ${verifyDuration}s`
      );
    } catch (err: any) {
      callbacks.onLog(`⚠ Source verification failed (non-blocking): ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────
  // Pipeline summary — cost, tokens, duration
  // ────────────────────────────────────────────────────
  try {
    const calls = getCallLog().filter(c => c.sessionId === currentSession.id);
    if (calls.length > 0) {
      const byRole = new Map<string, { cost: number; tokens: number }>();
      let totalCost = 0;
      let totalTokens = 0;
      for (const c of calls) {
        const role = c.role || 'unknown';
        const entry = byRole.get(role) || { cost: 0, tokens: 0 };
        const tokens = (c.usage?.promptTokens ?? 0) + (c.usage?.completionTokens ?? 0);
        entry.cost += c.costUsd ?? 0;
        entry.tokens += tokens;
        byRole.set(role, entry);
        totalCost += c.costUsd ?? 0;
        totalTokens += tokens;
      }
      const parts: string[] = [];
      for (const [role, data] of byRole) {
        const tokK = (data.tokens / 1000).toFixed(1);
        parts.push(`${role} $${data.cost.toFixed(4)} (~${tokK}k tok)`);
      }
      callbacks.onLog(`💰 Cost: ${parts.join(', ')} — Total: $${totalCost.toFixed(4)} (~${(totalTokens / 1000).toFixed(1)}k tok)`);
    }
  } catch {
    // non-blocking
  }

  const totalDuration = (Date.now() - pipelineStart) / 1000;
  const mins = Math.floor(totalDuration / 60);
  const secs = Math.round(totalDuration % 60);
  callbacks.onLog(`✅ Pipeline complete in ${mins > 0 ? `${mins}m ` : ''}${secs}s`);

  return currentSession;
}
