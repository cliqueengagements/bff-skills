---
name: stacks-alpha-engine
description: "Cross-protocol yield executor for Zest, Hermetica, Granite, and HODLMM with 3-tier yield mapping, sBTC Proof-of-Reserve verification, and multi-gate safety pipeline"
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "doctor | scan | deploy | withdraw | rebalance | migrate | emergency | install-packs"
  entry: "stacks-alpha-engine/stacks-alpha-engine.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Stacks Alpha Engine

## What it does

Cross-protocol yield executor covering **all 4 major Stacks DeFi protocols** — Zest v2, Hermetica, Granite, and HODLMM (Bitflow DLMM). Scans 6 tokens (sBTC, STX, USDCx, USDh, sUSDh, aeUSDC) across the wallet, reads positions and live yields from all 4 protocols, maps yield opportunities into 3 tiers (deploy now / swap first / acquire to unlock) with **YTG (Yield-to-Gas) profitability ratios**, verifies sBTC reserve integrity via BIP-341 P2TR derivation, checks 6 market safety gates + YTG profit gate, then executes deploy/withdraw/rebalance/migrate/emergency operations. Every write runs a mandatory safety pipeline: Scout -> Reserve -> Guardian -> YTG -> Executor. No bypasses.

**Protocol coverage:**

| Protocol | Token(s) | Deposit | Withdraw | Method |
|----------|---------|---------|----------|--------|
| Zest v2 | sBTC, wSTX, stSTX, USDC, USDh | `zest_supply` | `zest_withdraw` | MCP native |
| Hermetica | USDh -> sUSDh | `staking-v1.stake` | `staking-v1.unstake` + `silo.withdraw` | call_contract |
| Granite | aeUSDC | `liquidity-provider-v1.deposit` | `.redeem` (ERC-4626 shares) | call_contract |
| HODLMM | sBTC, STX, USDCx, USDh, aeUSDC (per pool) | `add-liquidity-simple` | `withdraw-liquidity-simple` | Bitflow skill |

**3-tier yield mapping:**

| Tier | Description | Example |
|------|-------------|---------|
| Deploy Now | You hold the token, one tx | sBTC -> Zest supply |
| Swap First | Need a Bitflow swap, then deploy | sBTC -> swap -> USDh -> Hermetica stake |
| Acquire to Unlock | Don't have the token yet | Need aeUSDC for Granite LP |

## Why agents need it

No other skill covers all 4 Stacks DeFi protocols with working read AND write paths for each. Agents hold different tokens — some have sBTC, others have USDh or aeUSDC. The engine scans whatever you hold and maps every earning path across every protocol, including swap-then-deploy routes with cost estimates. It also handles cross-protocol migration (withdraw from one, deploy to another) and emergency exit across all 4 protocols simultaneously.

## On-chain proof

- **Zest sBTC supply**: [txid b8ec03c3ba85c40840cdc933b61a14faf2a9516e1ce1314d9768228f3328803f](https://explorer.hiro.so/txid/b8ec03c3ba85c40840cdc933b61a14faf2a9516e1ce1314d9768228f3328803f?chain=mainnet) — 14,336 zsBTC shares received (block 7,495,066)
- **Hermetica staking**: Proven in PR #56 (hermetica-yield-rotator, Day 4 winner) — staking-v1.stake verified on-chain
- **HODLMM liquidity**: Proven in PR #141 (hodlmm-rebalance-arbiter) — add-liquidity-simple verified on-chain
- **Granite aeUSDC LP**: deposit/withdraw use plain (uint, principal) args — no trait_reference needed

## Safety notes

- Every write command runs the full safety pipeline: Scout (read state) -> PoR (verify sBTC backing) -> Guardian (6 gates) -> Executor. No gate can be skipped.
- PoR RED or DATA_UNAVAILABLE blocks ALL writes and suggests emergency withdrawal.
- PoR YELLOW blocks all writes (read-only mode).
- Guardian gates: slippage <=0.5%, 24h volume >=$10K, gas <=50 STX, 4h rebalance cooldown, price source availability.
- Crypto self-test failure (bech32m vectors or P2TR derivation) blocks ALL operations including reads.
- YTG (Yield-to-Gas) profit gate: blocks deploys where 7-day projected yield < 3x gas cost. Use `--force` to override.
- All write commands require `--confirm` to execute. Without it, a dry-run preview is returned.
- Post-conditions on all `call_contract` writes (including swap-then-deploy paths) prevent unexpected token transfers.
- Hermetica unstake has 7-day cooldown — engine warns and provides claim instructions.
- Granite LP accepts **aeUSDC only** (not sBTC). Engine correctly routes aeUSDC to Granite.
- Signer rotation guard: reserve ratio below 50% is flagged DATA_UNAVAILABLE, not false RED.
- Engine outputs transaction instructions — does not hold keys or sign directly.

## Output contract

All commands output JSON to stdout:

```json
{
  "status": "ok" | "refused" | "partial" | "error",
  "command": "scan" | "deploy" | "withdraw" | "rebalance" | "migrate" | "emergency",
  "scout": { "status", "wallet", "balances" (6 tokens), "positions" (4 protocols), "options" (3-tier, each with ytg_ratio + ytg_profitable), "best_move", "break_prices", "data_sources" },
  "reserve": { "signal": "GREEN|YELLOW|RED|DATA_UNAVAILABLE", "reserve_ratio", "score", "sbtc_circulating", "btc_reserve", "signer_address", "recommendation" },
  "guardian": { "can_proceed", "refusals", "slippage", "volume", "gas", "cooldown", "relay", "prices" },
  "action": { "description", "txids", "details": { "instructions": [...] } },
  "refusal_reasons": ["..."],
  "error": "..."
}
```

## Architecture

| Module | Role |
|--------|------|
| **Scout** | Wallet scan (6 tokens), positions (4 protocols), 3-tier yield options, break prices |
| **Reserve** | P2TR derivation, BTC balance, GREEN/YELLOW/RED signal |
| **Guardian** | Slippage, volume, gas, cooldown, relay, price gates |
| **Executor** | deploy, withdraw, rebalance, migrate, emergency |

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `scan` | read | Full report: 6 tokens, 4 protocols, 3-tier yields, PoR, safety gates |
| `deploy` | write | Deploy capital to a protocol (with --token flag for specific token) |
| `withdraw` | write | Pull capital from a specific protocol |
| `rebalance` | write | Withdraw out-of-range HODLMM bins, re-add centered on active bin |
| `migrate` | write | Cross-protocol capital movement (withdraw A + deploy B) |
| `emergency` | write | Withdraw ALL positions across all 4 protocols |
| `doctor` | read | 11 self-tests: crypto vectors, data sources, PoR, all protocol reads |

## Write Paths (verified on-chain)

| Protocol | Deposit | Withdraw | Token | Method |
|----------|---------|----------|-------|--------|
| Zest v2 | `zest_supply` | `zest_withdraw` | sBTC | MCP native |
| Hermetica | `staking-v1.stake(uint)` | `staking-v1.unstake(uint)` + `silo-v1-1.withdraw(uint)` | USDh/sUSDh | call_contract |
| Granite | `lp-v1.deposit(assets, principal)` | `lp-v1.redeem(shares, principal)` | aeUSDC | call_contract |
| HODLMM | `add-liquidity-simple` | `withdraw-liquidity-simple` | per pool pair | Bitflow skill |

All 4 protocols have **zero trait_reference** requirements in their write paths.

## Safety Pipeline (every write)

1. **Scout** reads wallet (6 tokens) + 4 protocols + yields + prices + YTG ratios
2. **Reserve (PoR)** verifies sBTC is fully backed by real BTC
3. **Guardian** checks 6 gates: slippage (<=0.5%), volume (>=$10K), gas (<=50 STX), cooldown (4h), relay, prices
4. **YTG gate** checks 7d projected yield > 3x gas cost (refuses unprofitable deploys)
5. All pass -> **Executor** outputs transaction instructions
6. Any fail -> refuse with specific reasons, no transaction

### PoR Signal Thresholds

| Reserve Ratio | Signal | Engine Action |
|---------------|--------|---------------|
| >= 99.9% | GREEN | Execute writes normally |
| 99.5-99.9% | YELLOW | Read-only, refuse all writes |
| < 99.5% | RED | Emergency withdrawal recommended |
| < 50% | DATA_UNAVAILABLE | Likely signer key rotation |

## Emergency Exit Coverage

| Risk | Detection | Exit Path |
|------|-----------|-----------|
| HODLMM out of range | Guardian: active bin vs user bins | `withdraw-liquidity-simple` |
| sBTC peg break | PoR: reserve ratio < 99.5% | Withdraw all 4 protocols |
| Hermetica unstake | Manual | `staking-v1.unstake` + 7-day claim |
| Zest rate drops | Scout: live utilization read | `zest_withdraw` + redeploy |
| Signer key rotation | PoR: ratio < 50% | DATA_UNAVAILABLE flag |

## Known constraints

### Granite Borrower Path (Blocked)
Granite `borrower-v1.add-collateral` requires `trait_reference` — blocked by MCP. The engine uses the **LP deposit path** (aeUSDC supply) which works without trait_reference.

### Hermetica Minting (Blocked)
Hermetica `minting-v1.request-mint` requires 4x `trait_reference`. Workaround: swap sBTC -> USDh on Bitflow, then stake. The engine generates swap + stake instructions.

### Non-Atomic Multi-Step
Swap-then-deploy and rebalance operations are 2+ transactions. If tx 1 confirms but tx 2 fails, capital sits safely in wallet.

### Hermetica 7-Day Cooldown
Unstaking sUSDh creates a claim. USDh is available after 7-day cooldown via `staking-silo-v1-1.withdraw(claim-id)`.

## Data Sources (12+ live reads)

| Source | Data |
|--------|------|
| Hiro Stacks API | STX + 5 FT balances, contract reads |
| Tenero API | sBTC/STX prices |
| Bitflow HODLMM API | Pool APR, TVL, volume, token prices |
| mempool.space | BTC balance at signer P2TR address |
| Zest v2 Vault | Supply position, utilization, interest rate |
| Hermetica staking-v1 | Exchange rate (USDh/sUSDh), staking status |
| Granite state-v1 | LP params, IR params, user position, utilization |
| HODLMM Pool Contracts | User bins, balances, active bin (8 pools) |
| sbtc-registry | Signer aggregate pubkey |
| sbtc-token | Total sBTC supply |
| DLMM Core | Bin price calculations |

## Dependencies

- `commander` (CLI parsing, registry convention)
- `tiny-secp256k1` (BIP-341 elliptic curve point addition for PoR)
- Node.js built-ins: `crypto` (SHA-256), `os`/`path`/`fs` (cooldown state)

### Why `tiny-secp256k1`?

The sBTC Proof-of-Reserve module derives the signer's Bitcoin P2TR address from the aggregate pubkey registered on Stacks. This requires a BIP-341 Taproot key tweak: `output_key = internal_key + H_TapTweak(internal_key) * G`. Node.js `crypto` does not expose raw EC point addition. `tiny-secp256k1` provides exactly one function we need: `xOnlyPointAddTweak()`.

## Doctor Self-Tests (11 checks)

1. BIP-350 bech32m test vectors
2. P2TR derivation from known G point
3. Hiro Stacks API
4. Tenero Price Oracle
5. Bitflow HODLMM API
6. mempool.space
7. sBTC Proof of Reserve (full golden chain)
8. Zest v2 sBTC Vault
9. Hermetica Staking (exchange rate read)
10. Granite Protocol (aeUSDC LP params)
11. HODLMM Pool Contracts

## x402 Paid Endpoints

Stacks Alpha Engine is free to run from the registry. For agents that want instant results without running 12+ API calls, paid x402 endpoints are available:

| Endpoint | What you get | Price | Pays back in |
|----------|-------------|-------|-------------|
| `/scan` | Full 7-section report: wallet, positions, 3-tier yields with YTG, PoR, break prices, safety gates | 500 sats | ~5 min of yield difference |
| `/reserve` | sBTC Proof-of-Reserve check: GREEN/YELLOW/RED signal with reserve ratio | 100 sats | Avoiding one bad trade |
| `/break-prices` | HODLMM range exit prices + safety buffer | 200 sats | One rebalance save |
| `/guardian` | 6-gate pre-flight safety check | 100 sats | One blocked bad tx |

All endpoints return the same JSON output as the CLI. x402 protocol shows price before payment — no surprises. Revenue flows to `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY` (Micro Basilisk, Agent #77).

## Disclaimers

### Financial Disclaimer
Stacks Alpha Engine provides data-driven yield analysis for informational purposes only. This is not financial advice. Users are solely responsible for their own investment decisions. Past yields do not guarantee future returns. Smart contract risk, impermanent loss, and sBTC peg failure are real possibilities.

### Accuracy Disclaimer
Data is live but not guaranteed. Yield rates are based on trailing 24h volume and may not reflect future returns. Hermetica APY is estimated from exchange rate drift. The engine reads 12+ data sources; if any are unavailable, output may be incomplete (status: "degraded").
