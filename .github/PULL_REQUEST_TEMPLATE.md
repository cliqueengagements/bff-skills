## Skill Submission

**Skill name:** <!-- your-skill-name -->
**Category:** <!-- Trading / Yield / Infrastructure / Signals -->
**HODLMM integration?** <!-- Yes / No -->

### What it does
<!-- 2-3 sentences -->

### On-chain proof
<!-- tx hash link or live output — no proof = not reviewed -->

### Registry compatibility checklist

- [ ] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [ ] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [ ] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [ ] `user-invocable` is the string `"false"`, not a boolean
- [ ] `entry` path is repo-root-relative (no `skills/` prefix)
- [ ] `metadata.author` field is present with your GitHub username
- [ ] All commands output JSON to stdout
- [ ] Error output uses `{ "error": "descriptive message" }` format

### Smoke test results

<details>
<summary>doctor output</summary>

```json
<!-- paste doctor output here -->
```

</details>

<details>
<summary>run output</summary>

```json
<!-- paste run output here -->
```

</details>

### Security notes
<!-- Does it write to chain? Move funds? Mainnet only? -->
