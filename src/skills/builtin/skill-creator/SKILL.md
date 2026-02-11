---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create a new skill (or update an existing skill) that extends agent capabilities with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill provides guidance for creating effective skills for ADS agents.

## About Skills

Skills are modular, self-contained folders that extend agent capabilities by providing specialized knowledge, workflows, and tools. They transform a general-purpose agent into a specialized one equipped with procedural knowledge.

### Skill Location Policy

1. Project-local: `$workspace/.agent/skills/<skill-name>`
2. Global: `~/.agent/skills/<skill-name>` (shared across workspaces)

Prefer project-local by default. Use global only when the user explicitly wants the skill available across multiple workspaces.

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name + description, required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/      - Executable code
    ├── references/   - Documentation for context
    └── assets/       - Files used in output
```

## Skill Creation Process

1. Understand the skill with concrete examples
2. Plan reusable resources (scripts, references, assets)
3. Initialize the skill (run init-skill.ts)
4. Edit the skill (implement resources and write SKILL.md)
5. Validate the skill (run validate-skill.ts)
6. Iterate based on real usage

### Skill Naming

- Lowercase letters, digits, and hyphens only
- Max 64 characters
- Short, verb-led phrases that describe the action
- Namespace by tool when it improves clarity (e.g., `gh-address-comments`)

### Step 1: Understanding the Skill

Ask the user for concrete examples of how the skill will be used. Relevant questions:
- "What functionality should this skill support?"
- "Can you give examples of how it would be used?"
- "What would a user say that should trigger this skill?"

### Step 2: Planning Resources

Analyze each example to identify reusable resources:
- `scripts/` — Code that gets rewritten repeatedly
- `references/` — Documentation needed during execution
- `assets/` — Templates, images, boilerplate for output

### Step 3: Initializing the Skill

Run the init script to scaffold the skill directory:

```bash
npx tsx scripts/init-skill.ts <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

Examples:

```bash
npx tsx scripts/init-skill.ts my-skill --path $workspace/.agent/skills
npx tsx scripts/init-skill.ts my-skill --path $workspace/.agent/skills --resources scripts,references
npx tsx scripts/init-skill.ts my-skill --path $HOME/.agent/skills
```

The `scripts/` directory referenced above is relative to this skill's own location:
`src/skills/builtin/skill-creator/scripts/`

### Step 4: Edit the Skill

#### Frontmatter

- `name`: The skill name
- `description`: Primary triggering mechanism. Include what the skill does AND when to use it. All "when to use" information must be here — the body is only loaded after triggering.

#### Body

Write instructions for using the skill and its bundled resources. Keep SKILL.md under 500 lines.

#### Progressive Disclosure

- Keep only core workflow in SKILL.md
- Move detailed reference material to `references/` files
- Reference them from SKILL.md with clear descriptions of when to read them

### Step 5: Validate the Skill

```bash
npx tsx scripts/validate-skill.ts <path/to/skill-folder>
```

Checks frontmatter format, required fields, and naming rules.

### Step 6: Iterate

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Update SKILL.md or bundled resources
4. Test again
