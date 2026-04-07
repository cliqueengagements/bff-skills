---
name: hodlmm-move-liquidity-agent
skill: hodlmm-move-liquidity
description: "Autonomous agent behavior for moving idle HODLMM liquidity back into the active earning range."
---

# Agent Behavior — HODLMM Move-Liquidity

## Decision order

1. Run `doctor --wallet <addr>`. If any check fails, stop and surface the blocker to the operator.
2. Run `scan --wallet <addr>`. Identify pools where `in_range` is `false`.
3. For each out-of-range pool, run `run --wallet <addr> --pool <id>` (dry-run) to preview the move plan.
4. Present the plan to the operator. Show old range, new range, drift distance, estimated token amounts, and gas cost.
5. Only proceed with `--confirm --password <pass>` after explicit operator approval.
6. After execution, verify both transaction IDs via the explorer URLs.

## Guardrails

- **Never execute without operator confirmation.** The `--confirm` flag is mandatory for on-chain writes. Without it, `run` produces a read-only preview.
- **Respect the 4-hour cooldown.** Do not attempt to bypass cooldown by modifying the state file. If cooldown is active, inform the operator and provide the remaining wait time.
- **Do not move in-range positions.** If the position is already in the active bin range, report `IN_RANGE` and take no action. Moving an in-range position wastes gas for zero benefit.
- **Gas budget: 0.1 STX** estimated for two transactions (0.05 STX each). If STX balance is below 1 STX, refuse to execute.
- **Active-bin-tolerance: ±2 bins.** The deposit contract call includes a tolerance parameter that causes the transaction to revert if the active bin has moved more than 2 bins since the plan was built. This protects against front-running and high-volatility slippage.
- **Deposit uses 98% of estimated withdrawal.** The 2% buffer prevents deposit failure from rounding differences. Any remainder stays in the wallet.
- **Sequential nonce ordering.** Withdrawal uses nonce N, deposit uses nonce N+1. The deposit will not execute until the withdrawal confirms. If the withdrawal fails, the deposit naturally drops from mempool.

## On error

- Log the full error payload from the JSON output.
- Do not retry automatically — surface the error to the operator with the specific failure reason.
- Common errors: wallet decryption failure, insufficient STX, pool not found, API timeout.
- If a broadcast fails, check the explorer for the transaction status before retrying.

## On success

- Report both transaction IDs (withdraw + deposit) with explorer links.
- Confirm the new bin range and estimated token distribution.
- Note the cooldown timer: next move available after 4 hours.
- Suggest running `scan` again after both transactions confirm (~10-20 minutes) to verify the position is now in range.
