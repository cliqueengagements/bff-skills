---
name: hodlmm-bin-guardian
description: "Monitors Bitflow HODLMM bins to keep LP positions in the active earning range. Fetches live pool state, checks if position is in-range, estimates current APR from volume data, and outputs a JSON recommendation. Read-only by default — rebalance actions require explicit human approval."
author: cliqueengagements
author_agent: "LAB Bounty Scout — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
user-invocable: true
arguments: "doctor | install-packs | run [--pool-id <id>]"
entry: "hodlmm-bin-guardian/hodlmm-bin-guardian.ts"
requires: [bitflow]
tags: [defi, read-only, mainnet-only, l2, infrastructure]
---

# HODLMM Bin Guardian

Monitors Bitflow HODLMM (DLMM) bins to keep LP positions in the active earning range.

## What it does

Fetches live Bitflow HODLMM pool state and sBTC/STX ticker data, checks whether an LP position is within the active earning bin range, estimates current fee APR from 7-day volume and liquidity, and outputs a strict JSON recommendation — HOLD or REBALANCE.

## Why agents need it

HODLMM positions stop earning fees the moment the market price moves outside the deposited bin range. This skill gives an autonomous agent a reliable, safe-to-run check that surfaces out-of-range positions and flags them for human-approved rebalancing — without ever spending funds autonomously.

## Safety notes

- **Read-only.** No transactions are submitted.
- **Mainnet-only.** Bitflow SDK does not support testnet.
- Refuses to recommend rebalance if 24h pool volume < $10,000 USD.
- Any actual rebalance (add/withdraw liquidity) requires explicit human approval before execution.

## Commands

### doctor

Checks that the Bitflow skill dependency is reachable and the network is set to mainnet.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
```

### install-packs

No additional packs required — depends only on the `bitflow` skill.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts install-packs --pack all
```

### run

Checks the default sBTC HODLMM pool (dlmm_1) and outputs a recommendation.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --pool-id dlmm_1
```

## Output contract

All outputs are JSON to stdout.

```json
{
  "in_range": true,
  "current_apr": "2.54%",
  "recommendation": "HOLD — Position is in range at active bin 8412. APR: 2.54%. Next check in 4 hours.",
  "pool_id": "dlmm_1",
  "active_bin": 8412,
  "volume_24h_usd": 142000,
  "liquidity_usd": 2100000,
  "slippage_ok": true
}
```

## Safety rules (from AGENT.md)

- 50 STX max per transaction
- 0.5% slippage cap
- 4-hour cooldown between rebalances
- Refuses rebalance if 24h pool volume < $10,000

## Known constraints

- sBTC price used for volume estimation is a fixed proxy (~$71k). APR is an approximation.
- Real in-range check requires wallet address to compare position bins vs active bin.
- Requires `bitflow` skill installed at `../bitflow/bitflow.ts` relative to skills root.
