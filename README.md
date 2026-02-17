# Branch Playground

Branch Playground is the main app for adversarial candidate-profile generation and fact-checking.

## What it does
- Ingests candidate/source material
- Runs writer + critic rounds to improve draft quality
- Audits extracted claims with verifier consensus
- Performs source provenance checks and URL validation
- Exports profile and audit outputs

## Stack
- React 19 + Vite 6 + TypeScript 5
- Tailwind CSS
- Multi-provider LLM abstraction (Gemini, xAI/Grok, OpenAI, Anthropic, HuggingFace, Qwen, DeepSeek, MiniMax)

## Setup
1. Install dependencies:
   - `npm install`
2. Create local environment file:
   - `cp .env.example .env`
3. Add your API keys to `.env` (gitignored):
   - `VITE_GEMINI_API_KEY`
   - `VITE_XAI_API_KEY`
   - `VITE_OPENAI_API_KEY`
   - `VITE_ANTHROPIC_API_KEY`
   - `VITE_HUGGINGFACE_API_KEY`
   - `VITE_QWEN_API_KEY`
   - `VITE_DEEPSEEK_API_KEY`
   - `VITE_MINIMAX_API_KEY`
4. Start dev server:
   - `npm run dev`

## Build and type-check
- `npx tsc --noEmit`
- `npm run build`

## Key handling
- Keys can be entered via Settings UI and are stored locally in browser storage.
- Key vault encryption is supported in-app.
- Use **Settings → AI Providers → Clear all saved API keys** to wipe stored keys (plain + encrypted).

## Workspace cleanup note
`branch-playground` is the canonical project. The older `branch-fact-checker-pro` export can be retired after migration.
