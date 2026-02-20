# Branch Playground — Product Requirements Document

## Overview

**Branch Playground** is a browser-only SPA (React + TypeScript + Vite) that generates nonpartisan, source-grounded candidate profiles for elections. It replaces manual research with an automated pipeline: web research → AI writing → adversarial critique → source verification → human review.

Every factual claim must trace back to a real URL with a verifiable quote. The system is designed to surface exactly what a voter needs to evaluate a candidate — without partisan spin, fabricated sources, or unsupported claims.

---

## Core Pipeline

```
CSV Import → Queue → Research → Write → Critique → Verify Sources → Audit → Export
```

### 1. Import & Queue

- Users upload a CSV or JSON with candidate names and metadata (office, state, district, party, election year, issues to cover).
- Each candidate enters a three-column workspace: **Queue** → **Processing** → **History**.
- Users may attach source URLs to queued candidates to seed the research phase.

### 2. Web Research

Before writing begins, the system searches the web for each candidate:

- **Search Providers**: DuckDuckGo (free, default) or Google Custom Search (paid, API key encrypted alongside LLM keys).
- **Query Strategy**: Multiple queries per candidate combining name + office + state (full name, not abbreviation) + election year + party. Dedicated per-platform social media queries (`site:facebook.com`, `site:x.com`, etc.). News queries targeting low-bias outlets (AP, Reuters, NPR, PBS, local papers).
- **Page Fetching**: Top ~12 unique URLs fetched via CORS proxy chain (`corsproxy.io` → `allorigins.win` → direct). Text extracted with `DOMParser`, boilerplate removed, capped at 15k chars/page.
- **Source Bias Tiers**: Pages are tagged by outlet bias level:
  - **Tier 1** (most trusted): AP, Reuters, PBS, NPR, C-SPAN, .gov
  - **Tier 2**: Major newspapers (NYT, WaPo, WSJ, local papers of record)
  - **Tier 3**: Partisan but factual (cable news sites, opinion-adjacent)
  - **Tier 4**: Unknown or unranked
  - Tier 1–2 sources are prioritized in the Writer's source material.
- **Social Media**: Individual queries per platform (Facebook, X/Twitter, Instagram, LinkedIn, YouTube, TikTok) using `site:` operators. Multiple account types detected: campaign, official, personal.
- **User-Provided URLs**: Always included in the research set, fetched first.

### 3. Writer Agent

An AI agent generates the candidate profile as structured JSON:

- **Bios**: Personal, professional, and political biographies.
- **Issues & Stances**: Policy positions organized by category (economy, public safety, immigration, etc.).
- **Links**: Campaign website, social media profiles, news articles.

**Sourcing Rules:**
- Every factual claim MUST cite a URL from the provided source material.
- Every `directQuote` MUST be a verbatim excerpt — CMD+F searchable on the source page.
- An unsourced claim is always better than a fabricated source.
- Source priority: official campaign website > .gov sites > reputable news > social media.
- Prohibited sources: BallotReady, VoteSmart, Wikipedia.

### 4. Adversarial Critic Loop

Three specialized critic agents review each draft:

| Agent | Weight | Focus |
|---|---|---|
| **Fact Checker** | 50% | Fabricated sources, unsupported claims, identity mismatches, missing citations |
| **Language Reviewer** | 25% | Partisan/biased language, loaded terms, non-neutral framing |
| **Style Auditor** | 25% | Template compliance, formatting rules, naming conventions |

**Scoring** (deterministic, deductive):
- Start at 100. Deduct per issue: fabrication (−50), critical (−30), major (−15), minor (−5), suggestion (−2).
- Floor at 0. Composite score = weighted average of all three agents.
- The loop runs up to N rounds (configurable, default 5) or until the score converges.

Critics can run in **specialized** mode (3 separate AI calls) or **combined** mode (single call). Each agent's system prompt is user-editable with localStorage persistence.

### 5. Source Verification

After the Writer/Critic loop converges, each stance's cited source is independently verified:

- **Fetch**: The cited URL is fetched via CORS proxy and text is extracted.
- **AI Verification**: An AI provider checks three things:
  1. **Quote exists**: The exact quote (or close paraphrase) appears on the fetched page.
  2. **Supports stance**: The quote actually supports the claimed policy position.
  3. **Correct candidate**: The page content is about the right person (critical for common names).
- **Confidence Score**: Each source gets a confidence value (0–1):
  - **≥ 0.8** (green): High confidence — quote found, supports stance, correct candidate.
  - **0.5–0.79** (yellow): Medium — partial match, paraphrase, or ambiguous candidate identity.
  - **< 0.5** (red): Low — quote not found, doesn't support stance, or wrong candidate.
- **Aggregation**: Each stance and bio gets a rolled-up confidence score (min of its sources' confidence values).
- **Low-confidence handling**: Visual flag only (does not block completion). Exported in JSON for downstream human review or re-verification with a paid provider.

### 6. Audit (Claim-Level Verification)

Separately from source verification, the audit phase:

1. **Extracts claims**: AI parses the draft into individual factual claims with source URL + supporting quote.
2. **Multi-verifier consensus**: Each claim is checked by 1+ AI verifiers. Verdicts: verified, disputed, unverified, insufficient-evidence. Consensus computed across verifiers.
3. **URL validation**: Deterministic check — fetches each cited URL, confirms it exists, searches for the quote on-page.
4. **Provenance check**: Deterministic — confirms every URL in the output appeared in the input source material. Fabricated URLs are flagged.

### 7. Export

Profiles export as:

- **Branch JSON**: Structured data matching the Branch API schema. Includes confidence scores on each stance, bio, and source.
- **Markdown**: Human-readable format with source citations. Low-confidence items flagged inline.
- **Audit Report**: Full claim-by-claim verification results with consensus verdicts and confidence percentages.

---

## Data Model (Key Types)

### Source
```typescript
{
  sourceType: 'website' | 'other' | 'questionnaire' | 'social' | 'news';
  directQuote: string;       // verbatim quote from the source
  url: string;
  title?: string;
  confidence?: number;        // 0–1, from source verification
  confidenceReason?: string;  // explanation for low confidence
}
```

### Stance
```typescript
{
  text: string;               // the stance statement
  sources: Source[];           // supporting sources with quotes + URLs
  complete: boolean;
  directQuote?: string;       // key quote
  sourceVerified?: 'verified' | 'unverifiable' | 'fabricated' | 'not-in-input';
  confidence?: number;        // 0–1, min of sources' confidence
  confidenceReason?: string;
  issuesSecondary: string[];
  textApproved: boolean;
  editsMade: boolean;
}
```

### LinkItem
```typescript
{
  mediaType: 'website' | 'facebook' | 'twitter' | 'instagram' | 'linkedin' | 'youtube' | 'tiktok' | 'other';
  url: string;
  title?: string;
  accountType?: 'official' | 'campaign' | 'personal';
  confidence?: 'high' | 'medium' | 'low';
}
```

---

## UI Architecture

### Three-Column Workspace
- **Queue (Column A)**: CSV-imported candidates waiting to start. Users can add source URLs, reorder, pause.
- **Processing (Column B)**: Candidates actively in the pipeline. Shows status badges (Researching → Writing → Fact-Checking → Complete/Error). No inline log — logs only in side panel.
- **History (Column C)**: Completed candidates. Click to review, export, or re-run.

### Candidate Side Panel
Slides out when clicking any candidate. Four tabs:

- **Info**: Metadata, source URLs (editable when queued), session stats, cost, source integrity summary.
- **Draft**: Full profile preview:
  - Bios with source badges and confidence indicators.
  - Issues with all stances visible (expandable, not truncated). Each stance is clickable → expands to show source quote (blockquote), source URL (linked), and confidence score (colored badge).
  - Links: campaign website featured prominently at top, social media as colored platform pills, articles with domain names.
- **Log**: Live build log with auto-scroll. Color-coded entries (search 🔎, fetch 🌐, success ✅, error ❌, warning ⚠).
- **Audit**: Claim-by-claim verification results with consensus verdicts.

### Settings
- **AI Providers**: API key management with encryption (AES-256-GCM, PBKDF2). Per-provider model lists and test buttons.
- **Web Research**: DuckDuckGo (free) vs. Google Custom Search (paid). Google CSE key encrypted alongside LLM keys.
- **Pipeline & Roles**: Assign providers to roles (writer, critic agents, extractor, verifiers). Configure critic run counts, convergence threshold, max rounds, audit mode.
- **Cost & Spending**: Monthly cap, per-session estimates, actual cost tracking.

---

## Non-Functional Requirements

- **Browser-only**: No backend server. All processing happens in the browser via API calls to AI providers.
- **CORS Proxies**: Required for fetching arbitrary web pages. Proxy chain with fallbacks.
- **Encryption**: API keys encrypted at rest (localStorage) with AES-256-GCM, PBKDF2 key derivation (600k iterations), password in sessionStorage (tab-scoped).
- **Cost Awareness**: Token usage tracked per call. Estimated and actual costs displayed. Monthly spending cap with warnings.
- **Rate Limiting**: Built-in rate limiter respects per-provider limits (especially Gemini free tier).

---

## Source Integrity Principles

1. **No fabrication**: Every URL in the output must trace to actual source material provided during research.
2. **Verbatim quotes**: Every `directQuote` must be findable (CMD+F) on the cited page.
3. **Correct identity**: Sources must be about the correct candidate — not a namesake or different election cycle.
4. **Bias transparency**: Source bias tier is tracked so users understand the quality of sourcing.
5. **Confidence over completeness**: It is better to have fewer stances with high-confidence sources than many stances with fabricated or low-confidence sources. An empty field is better than a wrong one.
6. **Human-in-the-loop**: Low-confidence items are flagged, not hidden. The system assists human review, not replaces it.
