# ADR-001: Majel Architecture

**Status:** Accepted  
**Date:** 2026-02-05  
**Authors:** Guff, Gem (Gemini), Opie (Claude)

## Context

Need a deterministic, privacy-focused interface for querying Star Trek Fleet Command (STFC) ship/crew roster data. Requirements:

- No hallucinations — answers must come from the data
- Privacy — game data should not train any AI models
- Low cost — personal use, target <$2/month
- Simple — minimal infrastructure, local execution

## Decision

### 1. Engine: Gemini 2.5 Flash-Lite (Paid Tier)

**Why:**
- 1M token context window (overkill for ~500 rows, but headroom is free)
- Paid tier = **no training on prompts/responses** (verified in Google Terms Dec 2025)
- Cost: ~$0.075/1M input tokens

**Rejected alternatives:**
- OpenAI GPT-4: Higher cost, smaller context
- Local LLM (Ollama): Insufficient instruction-following for structured data
- RAG/Vector DB: Unnecessary complexity for <30K tokens of data

### 2. Data Strategy: Brute Force Context Injection

**Why:**
- 500 rows × 200 chars ≈ 30K tokens = 3% of context window
- Full data in every prompt = deterministic, no retrieval errors
- CSV format is LLM-friendly and debuggable

**Rejected alternatives:**
- RAG (Pinecone/Chroma): Adds embedding model, vector store, retrieval tuning — all unnecessary
- Database queries: Requires schema mapping, SQL generation, error handling

### 3. Data Source: Google Sheets via OAuth

**Why:**
- Sheet is already the source of truth for roster data
- OAuth with `spreadsheets.readonly` scope = minimal permissions
- Token caching = one-time browser consent

**Rejected alternatives:**
- Public CSV link: Security through obscurity, not real auth
- Service account: More setup, better for multi-user (future option)
- Local CSV file: Manual sync burden

### 4. Execution: Local Python Script

**Why:**
- No server costs
- Credentials stay on local machine
- venv isolation = no system contamination

**Rejected alternatives:**
- Cloud function: Adds hosting cost, deployment complexity
- Docker: Overkill for single-file script
- Web UI: Adds frontend, CORS, hosting

## Consequences

### Positive
- Zero ongoing infrastructure cost
- Data never leaves local machine except to Gemini (no training)
- Simple to modify/extend
- Works offline (if CSV cached)

### Negative
- Single-user only (OAuth token is user-specific)
- Must re-run script to pick up sheet changes
- No persistent chat history across sessions (yet)

### Future Options
- Add chat history persistence (JSON file)
- Add `/reload` command for hot-refresh
- Service account mode for alliance sharing
- Image import pipeline if manual sheet updates become burden

## References

- [Gemini API Terms (Dec 2025)](https://ai.google.dev/gemini-api/terms) — Paid tier privacy clause
- [Google Sheets API](https://developers.google.com/sheets/api)
- Majel Barrett-Roddenberry (1932–2008) — namesake inspiration
