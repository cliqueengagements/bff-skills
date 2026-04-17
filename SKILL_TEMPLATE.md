# SKILL_TEMPLATE.md

> Copy this into your skill directory as `SKILL.md`. Fill in every field.
> The AIBTC validator enforces frontmatter — missing or malformed fields will block your PR.
>
> **Reference:** [aibtcdev/skills CONTRIBUTING.md](https://github.com/aibtcdev/skills/blob/main/CONTRIBUTING.md)

---

## 1. SKILL.md

````yaml
---
name: your-skill-name
description: "One sentence. What does this skill do and why does an agent need it?"
metadata:
  author: "your-github-username"
  author-agent: "Your Agent Name"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "your-skill-name/your-skill-name.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only"
---
````

> **⚠️ Frontmatter rules (CI-enforced):**
>
> | Rule | Wrong | Right |
> |---|---|---|
> | Fields under `metadata:` | `tags: [defi, write]` (top-level) | `metadata:` block with `tags: "defi, write"` |
> | Tags/requires format | YAML array `[defi, write]` | Comma-separated string `"defi, write"` |
> | user-invocable type | boolean `true` | String `"false"` |
> | entry path | `skills/your-skill-name/your-skill-name.ts` | `your-skill-name/your-skill-name.ts` (repo-root-relative) |
> | description quoting | `description: Does X` | `description: "Does X"` |
> | author field | (missing) | `metadata.author: "github-username"` (required) |

Then the skill body:

````markdown
# Your Skill Name

## What it does
2–3 sentences. Describe the capability, not the implementation.

## Why agents need it
What decision or action does this unlock for an autonomous agent?

## Safety notes
- Does this write to chain? Say so explicitly.
- Does it move funds? Warn here.
- Mainnet only? Say so.
- Any irreversible actions? Flag them.

## Commands

### doctor
Checks environment, dependencies, and wallet readiness. Safe to run anytime.
```bash
bun run your-skill-name/your-skill-name.ts doctor
```

### status
Read-only position/state check.
```bash
bun run your-skill-name/your-skill-name.ts status
```

### run
Core execution. Describe what happens step by step.
```bash
bun run your-skill-name/your-skill-name.ts run
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "result": "...", "details": { } }
```

**Error:**
```json
{ "error": "descriptive message" }
```

> **BFF extension (recommended):** For richer agent routing, you may use
> `{ "status": "success|error|blocked", "action": "...", "data": {}, "error": null }`.
> The flat format above is the **registry minimum** that passes CI.

## Known constraints
- Network requirements
- Wallet requirements
- Any edge cases or known failure modes
````

---

## 2. AGENT.md

**AGENT.md MUST start with YAML frontmatter.** The registry validator rejects it without these three fields.

````yaml
---
name: your-skill-name-agent
skill: your-skill-name
description: "One sentence describing the agent behavior for this skill."
---
````

Then the behavior rules:

````markdown
# Agent Behavior — Your Skill Name

## Decision order
1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Confirm intent before any write action.
3. Execute `run`.
4. Parse JSON output and route on result.

## Guardrails
- Never proceed past an error without explicit user confirmation.
- Never expose secrets or private keys in args or logs.
- Always surface error payloads with a suggested next action.
- Default to safe/read-only behavior when intent is ambiguous.

## On error
- Log the error payload
- Do not retry silently
- Surface to user with guidance

## On success
- Confirm the on-chain result (tx hash if applicable)
- Update any relevant state
- Report completion with summary
````

---

## 3. CLI pattern (Commander.js)

Use [Commander.js](https://github.com/tj/commander.js) for argument parsing. This is the convention in the aibtcdev/skills registry:

````typescript
import { Command } from "commander";

const program = new Command();

program
  .name("your-skill-name")
  .description("What the skill does");

program
  .command("doctor")
  .description("Check environment readiness")
  .action(async () => {
    console.log(JSON.stringify({ result: "ready" }));
  });

program
  .command("run")
  .description("Execute the core operation")
  .option("--amount <sats>", "Amount in sats")
  .action(async (opts) => {
    // output JSON to stdout
  });

program.parse();
````

### Shared infrastructure (for registry promotion)

When your skill is promoted to aibtcdev/skills, use these shared modules instead of hardcoded values:

| Instead of | Use |
|---|---|
| `"https://api.hiro.so"` | `src/lib/services/stacks-api.ts` |
| `process.env.STX_ADDRESS` | `src/lib/wallet.ts` → `getActiveWallet()` |
| Custom network detection | `src/lib/config/networks.ts` |

---

## 4. Pre-PR checklist

Run these before opening your PR. Paste the output into the PR description.

```bash
# 1. Validate frontmatter (must pass)
bun run scripts/validate-frontmatter.ts

# 2. Regenerate manifest
bun run scripts/generate-manifest.ts

# 3. Smoke tests
bun run skills/your-skill-name/your-skill-name.ts doctor
bun run skills/your-skill-name/your-skill-name.ts run
```

### Registry promotion checklist (after approval)

When your skill is promoted to aibtcdev/skills:

- [ ] Move skill directory to repo root (not under `skills/`)
- [ ] Add a row to the repo-root README.md skills table
- [ ] Run `bun run manifest` to regenerate `skills.json`
- [ ] Run `bun run typecheck` — must pass
- [ ] Commit format: `feat(your-skill-name): add your-skill-name skill`

---

## Allowed tags (use only from this list)

| Tag | Use when |
|---|---|
| `read-only` | Skill only reads chain state, never writes |
| `write` | Skill submits transactions |
| `mainnet-only` | Will not work on testnet |
| `requires-funds` | Wallet must have STX/sBTC to execute |
| `sensitive` | Handles keys, secrets, or private data |
| `infrastructure` | Foundational primitive other skills can build on |
| `defi` | Interacts with DeFi protocols (Bitflow, Zest, Alex, etc.) |
| `l1` | Operates on Bitcoin L1 |
| `l2` | Operates on Stacks L2 |

---

## Common rejection reasons

* **Wrong frontmatter format** — flat keys instead of `metadata:` nested convention
* **Missing AGENT.md frontmatter** — must have `name`, `skill`, `description`
* **YAML arrays instead of strings** — `[defi, write]` fails, use `"defi, write"`
* **Boolean instead of string** — `user-invocable: true` fails, use `"false"`
* **Wrong entry path** — prefixed with `skills/` instead of repo-root-relative
* **Missing author field** — `metadata.author` is required
* Vague description or missing safety constraints
* No JSON output discipline — ambiguous success states
* Hidden write risk (writes without explicit user intent)
* Weak error handling or non-idempotent behavior
* **No on-chain proof** — this is the most common content blocker
