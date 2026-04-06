# Daily Winner Operations Workflow

> One person, one doc, 30 minutes.

Complete daily operations playbook for the **AIBTC x Bitflow "Skills Pay the Bills"** competition. Read this document and run the entire daily cycle solo.

---

## Quick Reference

| What | Where |
|------|-------|
| Competition repo | github.com/BitflowFinance/bff-skills |
| Registry (winners go here) | github.com/aibtcdev/skills |
| Daily record | bff.army/agents.txt |
| Judging prompt | `docs/judging-prompt.md` in this repo |
| Validation script | `bun run scripts/validate-frontmatter.ts` |
| Manifest generator | `bun run scripts/generate-manifest.ts` |
| Scorecard formatter | `bun run scripts/format-judging-output.ts` |
| Feedback poster | `bun run scripts/post-feedback.ts` |
| Publish trigger | `winner-approved` label + Merge &rarr; Action runs automatically |

---

## Daily Cycle Checklist

### Stage 0: Intake (Automatic)

No operator action required.

- [ ] CI runs `validate-frontmatter.ts` on every new PR automatically
- [ ] Bot posts a pass/fail comment on the PR with fix instructions if validation fails
- [ ] Submitters self-fix using the bot's instructions and push again

---

### Stage 1: Pre-Judging (Manual, ~10 min)

Feed all Day N PRs to the judging agent and produce a formatted scorecard.

- [ ] Open Claude Code (or your preferred agent tool)
- [ ] Load the judging prompt:
  ```bash
  cat docs/judging-prompt.md
  ```
- [ ] Feed the prompt to the agent and point it at all open Day N PRs
- [ ] Save the raw agent output:
  ```bash
  # Example: save Day 4 raw output
  pbpaste > judging-day-4.txt
  ```
- [ ] Format the output into structured JSON:
  ```bash
  bun run scripts/format-judging-output.ts judging-day-4.txt > judging-day-4-formatted.json
  ```
- [ ] Review the formatted JSON — confirm scores, feedback drafts, and winner recommendation look sane
- [ ] Post the scorecard summary for team review

---

### Stage 2: Human Panel Review (~5 min)

Team aligns on the winner.

- [ ] Review the scorecard
- [ ] Discuss edge cases, re-rank if needed
- [ ] Select the winner by consensus
- [ ] Note the winning skill name, author, PR number, and final score

---

### Stage 3: Winner Announcement — Internal (~5 min)

Post announcements to Slack and the winning PR.

- [ ] Post the winner announcement. Copy-paste and fill in:

```
:trophy: *Day [X] Winner: [Skill Name]* :trophy:

Author: @[author-handle]
Score: [XX]/100
PR: https://github.com/BitflowFinance/bff-skills/pull/[XX]

[1-2 sentence summary of what the skill does and why it won.]

Next steps: contributor fixes any flagged issues, we label + merge, auto-publish to registry, $100 BTC sent.
```

- [ ] Post a comment on the winning PR. Copy-paste and fill in:

```
## :trophy: Congratulations — Day [X] Winner!

**Score:** [XX]/100

Your skill has been selected as today's winner. Here's what happens next:

1. **Fix any issues** flagged in the judging feedback below (if applicable)
2. Once clean, we'll apply the `winner-approved` label and merge
3. The publish action fires automatically — your skill goes live in the [aibtcdev/skills](https://github.com/aibtcdev/skills) registry
4. **$100 in BTC** will be sent to your wallet

Great work!
```

---

### Stage 4: Contributor Fixes — Non-winners (~5 min)

Post constructive feedback on non-winning PRs so contributors can improve.

- [ ] Open the formatted JSON and review the `feedbackDrafts` for each non-winning skill
- [ ] Edit any drafts that need tone or accuracy adjustments
- [ ] Build the PR map — match each skill name to its PR number:
  ```
  # Example: skill-alpha is PR #42, skill-beta is PR #45
  skill-alpha=42,skill-beta=45
  ```
- [ ] Dry run the feedback poster to preview comments:
  ```bash
  bun run scripts/post-feedback.ts \
    --file judging-day-4-formatted.json \
    --pr-map "skill-alpha=42,skill-beta=45" \
    --dry-run
  ```
- [ ] Review the dry-run output — confirm each comment targets the correct PR and reads well
- [ ] Post for real:
  ```bash
  bun run scripts/post-feedback.ts \
    --file judging-day-4-formatted.json \
    --pr-map "skill-alpha=42,skill-beta=45"
  ```

---

### Stage 5: Template Sync Check (~1 min)

Only needed if new format issues surfaced during today's judging.

- [ ] Check if `SKILL_TEMPLATE.md` and `README.md` have drifted:
  ```bash
  diff SKILL_TEMPLATE.md README.md | head -50
  ```
- [ ] If differences exist, update whichever file is behind so they stay aligned
- [ ] Skip this stage if no format issues came up today

---

### Stage 6: Final Approval & Merge (~2 min)

Merge the winning PR and trigger the publish action.

- [ ] Verify CI passes on the winning PR (green checkmark in GitHub)
- [ ] Apply the `winner-approved` label to the PR
- [ ] Click **Merge** (squash or merge commit — follow repo convention)
- [ ] `publish-to-aibtc.yml` fires automatically on merge (converts frontmatter, creates PR to `aibtcdev/skills`)
- [ ] Verify the publish action succeeded in the **Actions** tab:
  ```
  https://github.com/BitflowFinance/bff-skills/actions
  ```
- [ ] Confirm the downstream PR appeared in `aibtcdev/skills`

---

### Stage 7: Post-Merge Cleanup (~5 min)

Update the daily record, announce on X, check bonuses, send payment.

- [ ] Add entry to `agents.txt`. Copy-paste and fill in:

```
DAY [X] Winner: PR #[XX] — [PR Title]
```

- [ ] Post on X. Copy-paste and fill in:

```
:fire: Day [X] Winner — Skills Pay the Bills :fire:

[Skill Name] by @[author-handle]

[1-2 sentence description of what the skill does.]

Score: [XX]/100
PR: https://github.com/BitflowFinance/bff-skills/pull/[XX]

$100 in BTC sent! :bitcoin:

#AIBTC #Bitflow #SkillsPayTheBills #Bitcoin #Stacks
```

- [ ] **HODLMM bonus check:** If the winning skill integrates HODLMM, send an additional +$100 BTC
- [ ] Send BTC payment to the winner's wallet (manual wallet action)
- [ ] Confirm payment sent and record the transaction

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| CI didn't run on a PR | Check if the PR targets `main`. Check the Actions tab for workflow errors. |
| `publish-to-aibtc.yml` failed | Check Actions log. Usually an `AIBTC_SKILLS_PAT` permission issue — token may have expired or lack `repo` scope. |
| Submitter can't run validation locally | They need Bun installed: `curl -fsSL https://bun.sh/install \| bash` |
| Judging agent produces weird output | Check the prompt at `docs/judging-prompt.md` for drift. Re-run the agent with a clean prompt. |
| Wrong feedback posted on a PR | Delete the comment (three-dot menu on GitHub). Post the corrected version manually or re-run `post-feedback.ts` for that single PR. |
| `format-judging-output.ts` can't parse input | Input must start with `=== DAY X JUDGMENT ===`. Check for stray whitespace or missing header. |
| `post-feedback.ts` rate limited | Wait for the reset time shown in the error message. Or post the remaining comments manually. |

---

## Setup (One-Time)

These steps only need to happen once per environment.

### 1. GitHub Token

- [ ] Create a GitHub Personal Access Token (PAT) with `repo` scope
- [ ] Set it as an environment variable for `post-feedback.ts`:
  ```bash
  export GITHUB_TOKEN="ghp_your_token_here"
  ```
- [ ] For the publish action, add it as a repo secret named `AIBTC_SKILLS_PAT`

### 2. Bun

- [ ] Install Bun:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- [ ] Verify:
  ```bash
  bun --version
  ```
