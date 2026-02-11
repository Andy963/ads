---
name: tavily-research
description: "Run Tavily search and URL fetch via skill scripts (no MCP), and use the results in answers."
---

# Tavily Research
## Overview
This skill provides a Tavily-backed research workflow without MCP by running local scripts.
It supports:
- `search`: query web sources
- `fetch`: extract readable page content from URLs (Tavily extract)

## Requirements
- Node.js available (`node`)
- Dependency available: `@tavily/core`
- Environment variables:
  - `TAVILY_API_KEY` (preferred)
  - Optional proxy mapping:
    - `HTTP_PROXY` / `HTTPS_PROXY` (script maps these to Tavily proxy envs if needed)
    - Or set `TAVILY_HTTP_PROXY` / `TAVILY_HTTPS_PROXY` directly

## Scripts
- Search / fetch CLI:
  - `.agent/skills/tavily-research/scripts/tavily-cli.cjs`

## How to use (agent behavior)
1) Decide if web search is needed.
2) If needed, run:
- `node .agent/skills/tavily-research/scripts/tavily-cli.cjs search --query "..." --maxResults 5`
3) For a specific URL, run:
- `node .agent/skills/tavily-research/scripts/tavily-cli.cjs fetch --url "https://..." --extractDepth advanced --format markdown`
4) Summarize with citations (URLs) and state any limitations.

## Output discipline
- Never print API keys.
- Prefer returning compact summaries and a short list of sources.
