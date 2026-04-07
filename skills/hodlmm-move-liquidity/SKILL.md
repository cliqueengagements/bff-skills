---
name: hodlmm-move-liquidity
description: "Move idle HODLMM concentrated liquidity back into the active earning range — withdraw from drifted bins, re-deposit around the current active bin."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "doctor | scan | run | install-packs"
  entry: "hodlmm-move-liquidity/hodlmm-move-liquidity.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds"
---

# HODLMM Move-Liquidity

## What it does

Detects when an HODLMM concentrated liquidity position has drifted out of the active trading range, then moves the capital back. Executes two on-chain transactions against the Bitflow DLMM liquidity router: withdraw from stale bins, re-deposit into bins centered on the current active bin. Uses relative bin offsets so both transactions tolerate active-bin movement during confirmation.

## Why agents need it

Concentrated liquidity earns fees only when the active bin is inside the LP's bin range. Once price drifts away, the position earns zero. Every read-only HODLMM skill can detect this drift — none of them fix it. This skill closes the loop: detect drift, withdraw idle capital, re-deploy it where the fees are. An agent running this skill keeps its capital productive without human intervention.

## Safety notes

- **Writes to chain.** Two transactions per rebalance: one withdrawal, one deposit.
- **Moves funds.** Liquidity is removed from old bins and placed in new bins. No tokens leave the LP's wallet — they pass through the DLMM liquidity router contract.
- **Mainnet only.** All contract addresses are mainnet Stacks.
- **`--confirm` required.** Without it, `run` outputs a dry-run preview with full plan details. No transaction is broadcast.
- **postConditionMode: Allow** — HODLMM operations mint and burn DLP tokens, which cannot be expressed as sender-side post-conditions. The `--confirm` gate, cooldown, in-range check, gas check, and active-bin-tolerance parameter provide the safety layer.
- **4-hour cooldown** between moves on the same pool, enforced in code and persisted to disk.
- **Active-bin-tolerance** on deposit: the contract rejects the deposit if the active bin has moved more than ±2 bins from the expected value between withdrawal and deposit.

## Commands

### doctor

Check API access, wallet readiness, and dependency availability.

```bash
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts doctor --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

### scan

Read-only scan of all HODLMM pools. Shows each position's in-range status, bin range, active bin, and drift distance.

```bash
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts scan --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

### run

Assess a specific pool and generate a move plan. Dry-run by default.

```bash
# Preview (no on-chain action)
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run --wallet <addr> --pool dlmm_1

# Execute
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts run --wallet <addr> --pool dlmm_1 --confirm --password <pass>
```

### install-packs

No external packs required.

```bash
bun run hodlmm-move-liquidity/hodlmm-move-liquidity.ts install-packs
```

## Output contract

All commands emit JSON to stdout.

**scan — success:**
```json
{
  "status": "success",
  "action": "scan",
  "data": {
    "wallet": "SP...",
    "pools_scanned": 8,
    "positions_found": 2,
    "out_of_range": 1,
    "positions": [
      {
        "pool_id": "dlmm_1",
        "pair": "sBTC/USDCx",
        "active_bin": 510,
        "user_bins": [500, 501, 502, 503, 504],
        "user_bin_min": 500,
        "user_bin_max": 504,
        "in_range": false,
        "drift": 8,
        "total_x": "50000",
        "total_y": "120000000",
        "total_dlp": "980000"
      }
    ]
  },
  "error": null
}
```

**run — dry-run:**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "decision": "MOVE_NEEDED",
    "mode": "dry-run",
    "reason": "Position drifted 8 bins from active. Add --confirm --password <pass> to execute.",
    "health": { "..." : "..." },
    "plan": {
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx",
      "active_bin": 510,
      "old_range": { "min": 500, "max": 504, "bins": 5 },
      "new_range": { "min": 505, "max": 515, "bins": 11 },
      "withdraw": { "positions": 5, "estimated_x": "50000", "estimated_y": "120000000" },
      "deposit": { "bins": 11, "x_per_bin_above": "8166", "y_per_bin_below": "19600000" }
    }
  },
  "error": null
}
```

**run — executed:**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "decision": "EXECUTED",
    "health": { "..." : "..." },
    "plan": { "..." : "..." },
    "transactions": {
      "withdraw": { "txid": "0xabc...", "explorer": "https://explorer.hiro.so/txid/0xabc...?chain=mainnet" },
      "deposit": { "txid": "0xdef...", "explorer": "https://explorer.hiro.so/txid/0xdef...?chain=mainnet" }
    }
  },
  "error": null
}
```

**Error:**
```json
{ "status": "error", "action": "run", "data": null, "error": "descriptive message" }
```

**Blocked:**
```json
{ "status": "blocked", "action": "run", "data": { "cooldown_minutes": 42 }, "error": "Cooldown active — 42 minutes remaining" }
```

## Known constraints

- Requires `@stacks/transactions` and `@stacks/wallet-sdk` to be installed in the runtime environment.
- Two separate transactions means the deposit executes after the withdrawal confirms (sequential nonces). If the withdrawal fails, the deposit stays in mempool and eventually drops.
- Deposit amounts use 98% of estimated withdrawal return to account for rounding — a small dust amount may remain in wallet.
- Active-bin-tolerance of ±2 on deposit means high-volatility moments may cause the deposit to be rejected by the contract. Re-run after the market settles.
- Maximum 10-bin spread (configurable via `--spread`). Default is ±5 (11 bins total).
