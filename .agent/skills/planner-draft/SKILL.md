---
name: planner-draft
description: "Render an always-valid `ads-tasks` fenced TaskBundle JSON from a human prompt."
---

# Planner Draft

## Overview
This skill generates a strict `ads-tasks` fenced block containing TaskBundle v1 JSON.
It is designed to avoid common LLM formatting failures:
- Invalid JSON caused by raw newlines or control characters inside JSON strings
- Unreadable prompts caused by double-escaped `\\\\n` sequences

## Script
- `.agent/skills/planner-draft/scripts/render-ads-tasks.cjs`

## Usage

### From a prompt file (recommended)
1) Put your prompt in a text file using real newlines.
2) Run:

```bash
node .agent/skills/planner-draft/scripts/render-ads-tasks.cjs --title "My task" --prompt-file ./example.txt
```

### From stdin

```bash
cat ./example.txt | node .agent/skills/planner-draft/scripts/render-ads-tasks.cjs --title "My task"
```

## Output
On success, the script prints exactly one fenced block:

```ads-tasks
{
  "version": 1,
  "insertPosition": "back",
  "tasks": [
    {
      "title": "My task",
      "inheritContext": true,
      "prompt": "Goal:\\n- ...\\n"
    }
  ]
}
```

Paste that block into planner chat to create a TaskBundle draft.

