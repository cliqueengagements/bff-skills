# Micro Basilisk — Knowledge Base

> Single source of truth. Contracts, bugs, patterns, winning logic.
> **READ THIS BEFORE BUILDING OR PUSHING ANY SKILL.**
> Last updated: 2026-04-18 | **5 wins (Days 3, 4, 13, 14, 24)** | PR #339 stacks-alpha-engine APPROVED by Arc upstream | PR #494 HODLMM Inventory Balancer criterion-met via 3-leg mode

---

# 1. VERIFIED CONTRACTS

## Hermetica

**Deployer:** `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG`

| Contract | Functions (public) | Verified |
|----------|-------------------|----------|
| `staking-v1` | `stake(uint)`, `unstake(uint)`, `init-usdh-per-susdh` | Live 2026-04-08 |
| `staking-silo-v1-1` | `create-claim(uint, principal)`, `withdraw(claim-id: uint)`, `withdraw-many(list)` | Live 2026-04-08 |
| `staking-state-v1` | state tracking | — |

Read-only on silo: `get-claim(id)`, `get-current-claim-id()`, `get-current-ts()`

Unstake flow: `staking-v1.unstake()` → internally calls `staking-silo-v1-1.create-claim()` → wait ~7 day cooldown → `staking-silo-v1-1.withdraw(claim-id)`

`EXCHANGE_RATE_SCALE = 1e8` (NOT 1e18 — live: get-usdh-per-susdh returns 100000000 = 1.0)

**BUG WE FOUND:** Shipped skill called `initiate-unstake` and `complete-unstake` — neither exists. Fix: aibtcdev/skills#314.

## Bitflow HODLMM (DLMM)

**Router:** `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1`
**Core:** `SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1`
> API reference says router v-0-1 at SP3ESW... — v-1-1 at SM deployer is current mainnet. Verified via proofs 0b4a9c7c, 85ffba93, cd71c8a5, 0349cbb0.

### Router function selection — critical

| Function | List cap | Use when |
|----------|----------|----------|
| `move-liquidity-multi` | **220** | position has > 208 bins (we often do) — takes absolute `to-bin-id` |
| `move-relative-liquidity-multi` | **208** | position has ≤ 208 bins — takes `active-bin-id-offset` |
| `add-liquidity-multi` | 333 | deposit without withdraw |
| `add-relative-liquidity-same-multi` | **288** | deposit at offsets around active; takes per-bin (offset, x-amount, y-amount, min-dlp, max-fees) plus `active-bin-tolerance` optional guard |
| `withdraw-liquidity-multi` | 326 | withdraw without redeploy |
| `withdraw-relative-liquidity-same-multi` | **300** | withdraw at offsets around active; per-bin (offset, amount, min-x, min-y, pool-trait) + aggregate `min-x-amount-total` / `min-y-amount-total` floors |

**BUG WE FIXED (Day 21):** hodlmm-move-liquidity always called `move-relative-liquidity-multi` with a 208-cap. Our real positions carry 209–221 bins after prior rebalances. Clarity parse rejects with `BadFunctionArgument` pre-execution. Fix: route to `move-liquidity-multi` and pass absolute `to-bin-id = activeBin + offset - CENTER_BIN_ID`.

### Move tuple fields (`move-liquidity-multi`)
```
amount: uint (DLP shares at source bin)
from-bin-id: int (signed, relative to CENTER_BIN_ID)
to-bin-id: int (signed, absolute destination)
min-dlp: uint (at destination bin — see min-dlp caveat below)
max-x-liquidity-fee: uint (≤5% of amount)
max-y-liquidity-fee: uint (≤5% of amount)
pool-trait, x-token-trait, y-token-trait: contract-principal
```

### min-dlp — cross-bin DLP is NOT comparable to input

**CRITICAL:** `min-dlp = 95% of input amount` silently rejects any move where source and destination bin prices differ meaningfully. Source DLP at bin A represents tokens valued at price_A. Destination DLP at bin B represents tokens at price_B. The ratio is NOT 1:1 — it's (price_A × share_A) / price_B. For bin 460 → 617 with ~10× price delta, destination DLP may be 10% of input, not 95%.

**Safe patterns:**
- Same-bin or ±1 bin moves: `min-dlp = 95%` is fine.
- Cross-bin rebalance consolidation: `min-dlp = 1n` (router's internal arithmetic still enforces value conservation via the pool contracts).
- Properly computed: `min-dlp = 95% × (price_from / price_to) × amount` — price-aware scaling.

**BUG WE FIXED → UNFIXED → FIXED differently (Day 21):** Initial `min-dlp=1` was flagged as "too permissive" by reviewers on Day 14. I changed to 95% in d83755a. That 95% broke every cross-bin move with contract err u5001. Day 21 proof reverted to `min-dlp=1` with the rationale that router arithmetic guards value conservation regardless.

### Router error codes
| Error | Constant | Meaning |
|-------|----------|---------|
| u5001 | `ERR_NO_RESULT_DATA` | A sub-call returned err; fold cascades this through every subsequent iteration. **Actual first-failing error is masked** — debug by running with 1 move at a time |
| u5002 | `ERR_MINIMUM_X_AMOUNT` | Withdrew less X than min |
| u5003 | `ERR_MINIMUM_Y_AMOUNT` | Withdrew less Y than min |
| u5004 | `ERR_NO_ACTIVE_BIN_DATA` | Pool's active bin read failed |
| u5005 | `ERR_EMPTY_POSITIONS_LIST` | Sent list with 0 tuples |
| u5006 | `ERR_RESULTS_LIST_OVERFLOW` | Too many results in fold accumulator |
| u5007 | `ERR_INVALID_BIN_ID` | bin-id outside `[MIN_BIN_ID, MAX_BIN_ID]` range |
| u5008 | `ERR_ACTIVE_BIN_TOLERANCE` | active bin deviated from expected during tx |

### Core error codes (dlmm-core-v-1-1, u1001–u1040+)
Most common: u1022/u1023 (MINIMUM_X/Y_AMOUNT), u1024 (MINIMUM_LP_AMOUNT — the min-dlp trap), u1027 (INVALID_MIN_DLP_AMOUNT), u1030/u1031 (MAXIMUM_X/Y_LIQUIDITY_FEE).

### Network fee floor

Hardcoded `fee: 50000n` in the skill is **below mempool min** as of April 2026. Gets rejected with `FeeTooLow` pre-inclusion. Bump to ≥ `250000n` or fetch dynamically from Hiro `/v2/fees/transfer` (uSTX-per-byte rate × ~500 bytes typical swap tx) with floor.

### 3-leg rebalance pattern (withdraw-slice → swap → redeposit)

For positions where `swap + move-liquidity-multi` cannot close a composition gap (sprawled below/above active, where bins are asset-isolated by HODLMM design), the only path is to actually shift assets through the router:

1. **Withdraw-slice** via `withdraw-relative-liquidity-same-multi` — free wallet-side overweight token. Greedy-fill across overweight bins largest-first, per-bin slice cap (e.g. 80% shares), list ≤ 300, aggregate min-x/y floors for slippage.
2. **Corrective swap** — route 100% of freed overweight through `swap-simple-multi` with sender-pin `willSendLte` + contract-level `min-received` slippage.
3. **Redeposit** via `add-relative-liquidity-same-multi` at active ± 1 bin (X above active when X is underweight, Y below when Y is underweight; active holds both). **Pass `noneCV()` for `active-bin-tolerance` during mid-cycle** — active bin can drift between swap and redeposit, triggering `ERR_ACTIVE_BIN_TOLERANCE (u5008)`.

**Sequencing:** each leg must wait for on-chain confirmation before the next broadcasts — nonce collisions otherwise. Hiro indexing can lag tx by 2–3 min; set wait timeout ≥ 600s, not the naïve 120s. Prefix `0x` on tx lookups (`/extended/v1/tx/0x{id}`) for consistent behavior during propagation.

**State-marker semantics for 3-leg:** two intermediate states (`withdraw_done_swap_pending`, `withdraw_done_swap_done_redeposit_pending`) tagged with `last_cycle_mode: "rebalance_withdraw"`. Re-planning mid-cycle from partial state is fragile (direction inference from residual position is brittle); the cleanest recovery is surfacing the blocked state with explorer URLs and letting the operator re-run after on-chain landing — the planner reads the current ratio and plans a fresh cycle sized to close the residual gap.

**Add-liquidity return value quirk:** `add-relative-liquidity-same-multi` returns `active-bin-id` in SIGNED form (bin_id − CENTER_BIN_ID). Unsigned bin 661 = signed 161 in the response tuple. Don't confuse with unsigned API bin IDs.

**Per-bin reserves may be 0 in App API.** `/users/.../positions/.../bins` sometimes reports `reserve_x/reserve_y` as 0 even for non-empty positions — only `userLiquidity` (shares) is populated. Derive effective reserves: `rx = user_shares × pool_bin.reserve_x / pool_bin.liquidity` (same pattern `computeRatio` uses). Without this derivation, a planner filtering bins by raw reserves will see "no candidates" on any sprawled position.

**Live proof (PR #494 — 2026-04-18):** starting 0% X / 100% Y (50% deviation), 3 txs (`89315a8b` withdraw / `5195822e` swap / `135f490c` redeposit) → 49.95% X / 50.05% Y, **deviation 0.05%** — well inside ±5% band.

### Bitflow App API schema migration (Apr 2026)

The `/api/app/v1/pools` and `/api/app/v1/users/.../positions/.../bins` endpoints **migrated from snake_case → camelCase**. Previously-merged skills with strict snake_case readers return empty pools / 0 positions.

| Old (snake_case) | New (camelCase) | Endpoint |
|------------------|-----------------|----------|
| `pool_id` | `poolId` | pools |
| `pool_token` | `poolContract` | pools |
| `token_x` | `tokens.tokenX.contract` | pools |
| `token_y` | `tokens.tokenY.contract` | pools |
| `token_x_symbol` | `tokens.tokenX.symbol` | pools |
| `token_x_decimals` | `tokens.tokenX.decimals` | pools |
| `bin_step` | `binStep` | pools |
| `user_liquidity` | `userLiquidity` | user/positions |
| `reserve_x`/`reserve_y` | `reserveX`/`reserveY` | user/positions |
| `bin_id` | `binId` (sometimes) | user/positions |

**Quotes API (`/api/quotes/v1/bins/...`) still uses snake_case.** So `fetchPoolBins` doesn't need changes; `fetchPools` + `fetchUserPositions` do.

**CODE PATTERN:** always read `field ?? fieldCamel` with both fallbacks. The "fail loudly on schema change" comment I left in d83755a was fulfilled — by a painful debug session 9 days later.

### User positions endpoint quirk

`/users/{wallet}/positions/{poolId}/bins` returns `{bin_id, price, userLiquidity}` — **no reserve data**. Per-bin pool reserves must come from `/quotes/v1/bins/{poolId}` and be joined by bin_id. "Ghost bins" (user has DLP shares but pool reserves are 0) are extremely rare and not a usable filter criterion — most bins in a mature position have non-zero pool-side reserves.

### Constants
`CENTER_BIN_ID = 500`, `PRICE_SCALE = 1e8`, `MIN_BIN_ID`/`MAX_BIN_ID` per router
Bin invariant: **below-active = Y-only, above-active = X-only, active = both**

**Pools (8 active):**

| Pool ID | Pair | Fee | Contract suffix |
|---------|------|-----|-----------------|
| dlmm_1 | sBTC/USDCx | 10bps | `dlmm-pool-sbtc-usdcx-v-1-bps-10` |
| dlmm_2 | sBTC/USDCx | 1bps | `dlmm-pool-sbtc-usdcx-v-1-bps-1` |
| dlmm_3 | STX/USDCx | 10bps | `dlmm-pool-stx-usdcx-v-1-bps-10` |
| dlmm_4 | STX/USDCx | 4bps | `dlmm-pool-stx-usdcx-v-1-bps-4` |
| dlmm_5 | STX/USDCx | 1bps | `dlmm-pool-stx-usdcx-v-1-bps-1` |
| dlmm_6 | STX/sBTC | 15bps | `dlmm-pool-stx-sbtc-v-1-bps-15` |
| dlmm_7 | aeUSDC/USDCx | 1bps | `dlmm-pool-aeusdc-usdcx-v-1-bps-1` |
| dlmm_8 | USDh/USDCx | 1bps | `dlmm-pool-usdh-usdcx-v-1-bps-1` |

All pool contracts: deployer `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD`

## Zest Protocol v2

**Deployer:** `SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N`

| Contract | Purpose |
|----------|---------|
| `pool-borrow-v2-3` | Main pool — `get-user-reserve-data(principal, contract-principal)` |
| `borrow-helper-v2-1-7` | Helper (handles Pyth oracle fee) |
| `incentives-v2-2` | Rewards — `get-vault-rewards(principal, sbtc, wstx)` |
| `zsbtc-v2-0` | sBTC receipt token |

Reserve vaults (deployer: `SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y`): `reserve-vault-sbtc`, `reserve-vault-wstx`, `reserve-vault-ststx`, `reserve-vault-usdc`, `reserve-vault-usdh`

## Granite

**Contract:** `SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.liquidity-provider-v1`
- `deposit(uint, principal)` — aeUSDC only
- `redeem(uint, principal)` — ERC-4626: burns shares, returns aeUSDC

**BUG WE FIXED:** Use `redeem(shares)` NOT `withdraw(assets)`. ERC-4626 distinction.

## JingSwap

**Contract:** `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2`
Cycle phases: deposit (0), buffer (1), settle (2)

## Tokens

| Token | Contract | Dec | Asset Name (verified on-chain Apr 17) |
|-------|----------|-----|----------|
| sBTC | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | 8 | `sbtc-token` |
| USDCx | `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx` | 6 | `usdcx-token` |
| aeUSDC | `SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc` | 6 | `aeUSDC` |
| USDh | `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1` | 8 | `usdh` |
| sUSDh | `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.susdh-token-v1` | 8 | `susdh` |
| wSTX | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx` | 6 | — |
| stSTX | `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token` | 6 | — |

## APIs

| Service | URL |
|---------|-----|
| Hiro Mainnet | `https://api.mainnet.hiro.so` |
| Bitflow App | `https://bff.bitflowapis.finance/api/app/v1` |
| Bitflow Quotes | `https://bff.bitflowapis.finance/api/quotes/v1` |
| Tenero | `https://api.tenero.io` |
| Pyth Hermes | `https://hermes.pyth.network` |
| Explorer | `https://explorer.hiro.so/txid` |

**Bitflow API = snake_case only.** `pool_id`, `pool_token`, `active_bin`. No camelCase fallbacks.

**BUG WE FIXED:** camelCase fallbacks (`p.poolId ?? p.pool_id`) silently mask wrong fields. Removed.

## Pyth Price Feeds

| Asset | Feed ID |
|-------|---------|
| BTC | `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| STX | `ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17` |

## Nonce Handling

```typescript
const data = await fetchJson(`${HIRO_API}/extended/v1/address/${wallet}/nonces`);
const nextNonce = data.possible_next_nonce;
if (nextNonce !== undefined) return BigInt(Number(nextNonce));
const lastExec = data.last_executed_tx_nonce;
if (lastExec !== undefined) return BigInt(Number(lastExec) + 1);
return 0n;
```

Known issues: Hiro nonce lags mempool; sequential txs need manual increment; sponsor relay has own tracking (nonce_health, nonce_heal MCP tools).

---

# 2. SAFETY LIMITS

| Limit | Value | Context |
|-------|-------|---------|
| Min-dlp on HODLMM moves | ≥95% of input | tx reverts if violated |
| Max liquidity fee | ≤5% of amount | tx reverts if violated |
| Min STX for ops | 1 STX | refuse below this |
| HODLMM cooldown | 4h per pool | persisted to disk |
| Max bin spread | ±10 | hodlmm-move-liquidity |
| Max autonomous stake | 500 USDh | hermetica-yield-rotator |
| Max DCA slippage | 10% hard | dca |
| Max sBTC repay/op | 0.005 BTC | zest-auto-repay |
| Max sBTC repay/day | 0.01 BTC | zest-auto-repay |
| Default tx fee | 50,000 µSTX | stacks-alpha-engine |
| Rebalance per-bin slice cap | 80% of user shares (`REBALANCE_MAX_SLICE_BPS = 8000`) | hodlmm-inventory-balancer 3-leg |
| Rebalance redeposit spread | ±1 bin from active (`REBALANCE_ADD_OFFSET_BINS = 1`) | hodlmm-inventory-balancer 3-leg |
| Rebalance add-liquidity tolerance | `noneCV()` mid-cycle; otherwise 2 bins max-deviation | hodlmm-inventory-balancer 3-leg |
| Mainnet tx confirmation wait | 600s default (not 120s) | any sequential-tx flow |
| Granite redeem post-condition cap | `shares × 2n` (2×), `gte: "1"` floor | stacks-alpha-engine |
| Swap fee floor | `FEE_SWAP_FLOOR_USTX = 250_000n` | all swap-executing skills |

---

# 3. BUGS FOUND & FIXED

| # | Bug | Severity | Where | Fix |
|---|-----|----------|-------|-----|
| 1 | `initiate-unstake` / `complete-unstake` don't exist on-chain | Critical | hermetica-yield-rotator | aibtcdev/skills#314 |
| 2 | `min-dlp: 1` = no slippage protection | Critical | hodlmm-move-liquidity | d83755a: 95%/5% |
| 3 | camelCase API fallbacks mask wrong fields | Medium | hodlmm-move-liquidity | d83755a: snake_case only |
| 4 | `EXCHANGE_RATE_SCALE = 1e18` (actual: 1e8) | Medium | stacks-alpha-engine | display only, no fund risk |
| 5 | `withdraw` vs `redeem` on Granite (ERC-4626) | Medium | stacks-alpha-engine | b0037ce |
| 6 | `bitflow:bitflow` swap ref doesn't resolve | Medium | stacks-alpha-engine | 3ad7829: DLMM swap router |
| 7 | `PostConditionMode.Allow` without justification | Review flag | multiple | inline comment + SKILL.md |
| 8 | Bitflow App API is camelCase (`poolId`, `tvlUsd`, `feesUsd1d`, `apr24h`), not snake_case. Bins/position API IS snake_case (`active_bin_id`, `bin_id`, `user_liquidity`). | Medium | sbtc-capital-allocator | Fixed all field references. Two different conventions in the same API. |
| 9 | `feesUsd1d / tvlUsd` for APY is wrong — fees were earned against unknown intra-day TVL, not today's snapshot | Medium | sbtc-capital-allocator | Use 7d-smoothed: `(feesUsd7d / 7) / tvlUsd * 365`. Cross-validate against Bitflow's full-period `apr` (not `apr24h`). |
| 10 | Zest `current-liquidity-rate` is 1e6 precision (already annualized), NOT Ray (1e27). MCP `yield_dashboard_apy_breakdown` divides by 1e27 → returns 0. | Critical | sbtc-capital-allocator | `Number(rateRaw) / 1e6` = correct APY. Value 163457 = 0.16% APY. |
| 11 | Stacks blocks are ~5 seconds (Nakamoto upgrade), not 10 minutes | Medium | sbtc-capital-allocator | Zest rate is already annualized — no blocks-per-year multiplication needed. |
| 12 | Monitor oracle silently broken — `dlmm1.tokens.token_x.price_usd` (snake_case) always returned `undefined`, so `pool_implied_btc_usd` was always 0 and divergence always 0. Oracle check never fired. | Critical | sbtc-capital-allocator | Fixed to `dlmm1.tokens.tokenX.priceUsd` (camelCase). Now returns real divergence (e.g. 0.279%). |
| 13 | Tenero whale trades endpoint (`/v1/stacks/whale-trades`) returns 404 on public API. MCP tool `tenero_whale_trades` works (internal/authenticated route). | Medium | sbtc-capital-allocator | Replaced with Stacks mempool scan via Hiro API (`/extended/v1/tx/mempool`). Catches repositioning before settlement. |
| 14 | `bitflow_hodlmm_add_liquidity` MCP tool does not exist | Critical | sbtc-capital-allocator | Replaced with `call_contract` + `add-relative-liquidity-multi` on the DLMM router. Fully computed args with active bin offset, token traits, 95%/5% slippage. |
| 15 | ALEX DEX sBTC pools have zero volume — all `baseVolume: 0` across 10+ sBTC pools | Info | sbtc-capital-allocator (research) | ALEX not viable as third sBTC yield protocol. Only HODLMM and Zest have real volume. |
| 16 | DCA at 0% APY as a protocol entry can never win risk-adjusted ranking — only triggers via floor check hack | Design | sbtc-capital-allocator | DCA is an execution strategy (HOW to enter), not a yield protocol (WHERE to deploy). Implemented as `execution_mode: "lump_sum" | "dca"` triggered by risk signals. |
| 17 | SKILL.md/AGENT.md referenced `bitflow_hodlmm_add_liquidity` after code was changed to `call_contract` — doc/code mismatch | Medium | sbtc-capital-allocator | Updated both docs to match actual MCP tool used. |
| 18 | Missing `fee_spike: false` on Zest entries in recommend and execute yields arrays — would crash on `ranked.some(y => y.fee_spike)` | Medium | sbtc-capital-allocator | Added `fee_spike: false` to all non-HODLMM yield entries. |
| 19 | Relay health gate always returns `ok: true` — no-op, misleading "6 gates" claim | Medium | stacks-alpha-engine | f457dc4: removed relay gate, Guardian now 5 real gates. Relay checked at MCP runtime. |
| 20 | `scoutHermetica` `has_position` never set to `true` — emergency exit won't fire for Hermetica | Critical | stacks-alpha-engine | f457dc4: patch `has_position` from wallet sUSDh balance after parallel scan. |
| 21 | STX fallback price hardcoded at `0.216` — stale price silently flows into YTG ratios | Medium | stacks-alpha-engine | f457dc4: fallback → `0`, forces Guardian price-source gate refusal. |
| 22 | Swap-then-deploy Step 2 amount substitution invisible to agent runtimes | Medium | stacks-alpha-engine | f457dc4: added `requires_substitution: true` to Hermetica + Granite swap paths. |
| 23 | `PRICE_SCALE = 1e8` defined but break-price uses raw `1e6` for bin prices | Nit | stacks-alpha-engine | f457dc4: added `BIN_PRICE_SCALE = 1e6` constant, used in break-price reads. |
| 24 | `move-relative-liquidity-multi` list cap 208, positions routinely carry 209–221 bins | Critical | hodlmm-move-liquidity | Day 21: route to `move-liquidity-multi` (cap 220), pass absolute `to-bin-id = (activeBin - CENTER_BIN_ID) + offset` |
| 25 | `min-dlp = 95% of input` rejects cross-bin moves because destination-bin DLP is price-indexed, not share-indexed | Critical | hodlmm-move-liquidity | Day 21: `min-dlp = 1n` for cross-bin rebalance; router arithmetic guards value conservation. Proper fix: price-aware `95% × (price_from / price_to) × amount` |
| 26 | u5001 `ERR_NO_RESULT_DATA` router error MASKS the real first-failing error via fold cascade | Debug-hostile | router-v-1-1 | Day 21: debug by reducing moves list to 1 tuple and re-broadcasting — real error from dlmm-core surfaces without cascade mask |
| 27 | Hardcoded `fee: 50000n` below current mempool minimum — `FeeTooLow` pre-inclusion | Medium | hodlmm-move-liquidity | Day 21: bump to `250000n` or call `get_stx_fees` dynamically |
| 28 | Bitflow App API migrated snake_case → camelCase Apr 2026; skill removed camelCase fallbacks in d83755a per review "suggestion" | Critical (self-inflicted) | hodlmm-move-liquidity | Day 21: restore fallbacks `p.pool_id ?? p.poolId`, `tokens.tokenX.contract`, `userLiquidity`. Keeps skill resilient to schema drift. The "fail loudly" comment was fulfilled — 9 days later |
| 29 | hodlmm-move-liquidity's `run` declares `--wallet <address>` as `requiredOption`; composers that don't pass it get cryptic "required option '--wallet' not specified" | Critical | hodlmm-inventory-balancer | PR #494 3b314e6: thread `stxAddress` through `invokeMoveLiquidityRedeploy` |
| 30 | hodlmm-move-liquidity no-ops on `IN_RANGE` positions without `--force`; inventory-drift skills need `--force` since drift is orthogonal to price-range | Medium | hodlmm-inventory-balancer | PR #494 3b314e6: always pass `--force` from inventory balancer |
| 31 | hodlmm-move-liquidity emits success as `data.transaction.txid` (nested); composers reading `data.tx_id` / `data.txid` fail to extract | Medium | hodlmm-inventory-balancer | PR #494 a968a47: parser falls back through `data.tx_id ?? data.txid ?? data.transaction.txid` |
| 32 | hodlmm-move-liquidity writes cooldown marker BEFORE tx confirms on-chain; a reverted broadcast still blocks the next cycle for 4h | Medium | hodlmm-move-liquidity | Pending upstream fix: wait for `tx_status === success` before writing `last_move_at` |
| 33 | Token asset names in earlier KB versions were wrong for 3 of 5 HODLMM tokens (USDCx, aeUSDC, USDh) | Medium | documentation | Verified on-chain Apr 17 — USDCx: `usdcx-token`, aeUSDC: `aeUSDC`, USDh: `usdh` |
| 34 | `--password <pw>` via argv leaks through `/proc/<pid>/cmdline` and `ps auxww` to any user on the host for the process lifetime. Applies BOTH to the parent CLI of any skill AND to child invocations via `spawnSync` | High | all skills | Remove the `--password` CLI flag entirely; read from `WALLET_PASSWORD` env var only. For child spawns, pass via `env: { ...process.env, WALLET_PASSWORD: password }` in `spawnSync` opts, never `args.push("--password", pw)`. Env vars visible only to same-user/root via `/proc/environ`. Arc/Diego flagged this on PR #494 — treat as universal standard |
| 35 | Granite `redeem()` post-condition cap `shares + shares/10n` (10% interest buffer) silently breaks long-held positions whose accumulated interest exceeds 10% — tx reverts because pool tries to send more than the cap allows | Medium | stacks-alpha-engine | BFF #499: raise to `shares * 2n`; `gte: "1"` floor on wallet side still catches zero-return bugs |
| 36 | `migrate --from X --to Y` without `--amount` defaulted to `scout.balances.sbtc.amount × 1e8` regardless of source protocol — stablecoin-only wallets (Hermetica/Granite source) got silent zero-amount deploys | Medium | stacks-alpha-engine | BFF #499: require `--amount` (positive int) in Step 0 validation; no implicit fallback |
| 37 | Hardcoded `V1_ELIGIBLE_POOLS = Set<string>(["dlmm_1",...,"dlmm_8"])` requires code push + redeploy for every new HODLMM pool — operators blocked until skill update | Medium | hodlmm-inventory-balancer | PR #494 `ec34613`: derive dynamically from `/api/app/v1` with predicate `pool_status === true && pool_contract.startsWith("${HODLMM_POOL_DEPLOYER}.")`. Contract-prefix match is the JingSwap exclusion (not an allowlist) |
| 38 | Same stale `fee: 50000n` (bug #27 on hodlmm-move-liquidity) replicated verbatim in hodlmm-inventory-balancer swap path | Medium | hodlmm-inventory-balancer | PR #494 `ec34613`: `estimateSwapFeeUstx()` helper queries Hiro `/v2/fees/transfer` for uSTX-per-byte × 500 byte budget, floors at `FEE_SWAP_FLOOR_USTX = 250_000n`. Same mempool-derived-with-floor pattern as aibtcdev/skills#338 |
| 39 | v1 `swap + move-liquidity-multi` pipeline is **value-conserving and bin-to-bin** — cannot convert LP X↔Y composition when position is sprawled (below/above active holds one asset exclusively by HODLMM design). Produces "tempo characteristic" plateau, never crosses target ± min-drift-pct | Architectural | hodlmm-inventory-balancer | PR #494 `deff816`: 3-leg mode `withdraw-slice → swap → redeposit` behind `--allow-rebalance-withdraw` flag. Adds the missing primitive (redeposit of wallet-side swap output into LP) |
| 40 | `add-relative-liquidity-same-multi` with `active-bin-tolerance={expected, max-deviation}` aborts with `ERR_ACTIVE_BIN_TOLERANCE (u5008)` if active bin drifts beyond max-deviation between broadcast and inclusion. Mid-cycle race condition: our swap in leg 2 moves active before leg 3 lands | Medium | hodlmm-inventory-balancer 3-leg | PR #494 `deff816`: pass `noneCV()` for active-bin-tolerance on mid-cycle redeposits. Widening tolerance insufficient because the active bin can move arbitrarily far on high-volume pools |
| 41 | `add-relative-liquidity-same-multi` returns `active-bin-id` in SIGNED form (unsigned 661 = signed 161, offset by `CENTER_BIN_ID = 500`). Don't confuse with unsigned App API bin IDs when parsing tx results | Low (debug-hostile) | hodlmm-inventory-balancer | PR #494: KB entry — always subtract/add 500 when reconciling tx result bin IDs with API bin IDs |
| 42 | Hiro `/extended/v1/tx/{txId}` without `0x` prefix occasionally 404s during propagation (confirmed tx invisible for ~30–60s). Naïve retry loops mask as "pending" | Medium | all mainnet-writing skills | Always query with `0x` prefix: `/extended/v1/tx/0x${txId}`. Applies to Hiro mainnet + testnet |
| 43 | Mainnet tx propagation + Hiro indexing routinely exceeds 120s on congested blocks (saw 150s+ for a successful withdraw-slice). A 120s wait timeout triggers a false-failure abort before the next leg can broadcast, leaving state marker in intermediate status | Medium | hodlmm-inventory-balancer | PR #494 `1904432`: `waitForTxConfirmation` default 120s → 600s; 6s poll interval. Still surfaces genuine aborts immediately via non-`pending` `tx_status` |
| 44 | `fetchUserPositions` on `/users/.../positions/{pool}/bins` sometimes returns `reserve_x/reserve_y = "0"` even for non-empty bins — only `userLiquidity` is populated. Planners filtering "overweight bin candidates" by raw reserves see empty list on any sprawled position | Medium | hodlmm-inventory-balancer 3-leg | PR #494 `deff816`: derive effective reserves: `rx = userShares × poolBin.reserve_x / poolBin.liquidity` (same derivation `computeRatio` uses). Join user shares against pool-side reserves from `/quotes/v1/bins/{poolId}` |

**Verification command:**
```bash
curl -s "https://api.mainnet.hiro.so/v2/contracts/interface/{deployer}/{contract}" | jq '.functions[] | select(.access=="public") | .name'
```

**Bitflow API field convention (updated Apr 17):**
```
App API (/api/app/v1/pools):                  camelCase (poolId, tvlUsd, tokens.tokenX.*)
App API (/api/app/v1/users/.../positions/bins): camelCase (binId, userLiquidity, reserveX)
Quotes API (/api/quotes/v1/bins/{poolId}):    snake_case (bin_id, active_bin_id, reserve_x)
```
Pattern: always read `field ?? fieldCamel ?? fallback` — two conventions in same API, either endpoint can migrate without notice.

**Zest rate precision:**
```
current-liquidity-rate = 163457 → 163457 / 1e6 = 0.16% APY (NOT 1e27 Ray)
current-variable-borrow-rate = 5307948 → 5.31% borrow rate
Supply APY = borrow_rate × utilization
```

---

# 4. PRE-PUSH AUDIT CHECKLIST

### Contracts
- [ ] Every address verified against live Hiro API
- [ ] Every function name verified against contract interface
- [ ] Two-contract flows checked (e.g., Hermetica stake → silo withdraw)

### Slippage & Safety
- [ ] `min-dlp` ≥ 95% of input
- [ ] `max-fee` ≤ 5% of amount
- [ ] PostConditionMode.Allow justified in code + SKILL.md
- [ ] `--confirm` gate on all writes
- [ ] Gas check (refuse < 1 STX)
- [ ] Cooldown enforced + persisted to disk

### Precision
- [ ] All amounts BigInt (never float)
- [ ] Correct decimals (sBTC=8, USDCx=6, USDh=8, aeUSDC=6)
- [ ] Rate scales verified (Hermetica=1e8, Zest=1e6 NOT 1e27)
- [ ] No `value: 0` — use `0n`

### APIs
- [ ] Bitflow App API: camelCase (`poolId`, `tvlUsd`, `feesUsd1d`). Bins/Position API: snake_case (`active_bin_id`, `bin_id`)
- [ ] Hiro: field names match actual response

### Docs
- [ ] Every CLI flag in code → SKILL.md
- [ ] Every output state → output contract examples
- [ ] AGENT.md: `## Decision order`, `skill:` matches SKILL.md
- [ ] Commander.js (not custom parsing)
- [ ] `user-invocable: "false"`, tags as comma-separated quoted strings
- [ ] `entry:` repo-root-relative (no `skills/` prefix)

### HODLMM Specific
- [ ] CENTER_BIN_ID = 500
- [ ] Directional: below → [-spread, 0], above → [0, +spread]
- [ ] Router: `SM1FKX...dlmm-liquidity-router-v-1-1`

### ERC-4626
- [ ] `redeem(shares)` not `withdraw(assets)`
- [ ] Post-conditions: pool outflow (lte) + wallet receive (gte)

### Multi-step / Swap-then-deploy
- [ ] `requires_substitution: true` on any step whose amount depends on prior step output
- [ ] No hardcoded fallback prices — use `0` to trigger Guardian gate refusal
- [ ] Every `has_position` field actually gets set from on-chain data (not left as default `false`)

### Guardian gates
- [ ] Every gate actually checks something — no no-op gates returning `ok: true`
- [ ] Gate count in SKILL.md/AGENT.md matches actual code
- [ ] Named constants for all scale factors (no raw `1e6` / `1e8` literals)

### Secrets handling
- [ ] NO `--password <pw>` CLI flag on any command (argv leaks via `/proc/<pid>/cmdline` and `ps auxww`)
- [ ] Password read from `WALLET_PASSWORD` env var only
- [ ] Child `spawnSync`: pass password via `env: { ...process.env, WALLET_PASSWORD: pw }`, NEVER `args.push("--password", pw)`
- [ ] AGENT.md explicitly notes absence of `--password` flag as intentional (not oversight)

### Pool eligibility
- [ ] Eligibility derived dynamically from `/api/app/v1` — NOT a hardcoded `Set<string>`
- [ ] Predicate checks `pool_status === true` AND contract-prefix matches the HODLMM deployer (JingSwap exclusion)
- [ ] New pools pick up without code push or redeploy

### Fee handling
- [ ] Mempool-derived fee via Hiro `/v2/fees/transfer` × byte budget
- [ ] Floor at `FEE_SWAP_FLOOR_USTX = 250_000n` (or equivalent named constant)
- [ ] No raw `fee: 50000n` — 50k is below current mempool min

### Tx confirmation waits
- [ ] Default timeout ≥ 600s for sequential-tx flows (Hiro indexing can lag 2–3 min)
- [ ] Poll interval 6s, not 4s
- [ ] Tx lookups prefixed with `0x`: `/extended/v1/tx/0x${txId}`
- [ ] Non-`pending` status surfaces immediately (don't swallow as pending)

### 3-leg / multi-tx state markers
- [ ] Intermediate states enumerated (`withdraw_done_swap_pending`, etc.) and tagged with `last_cycle_mode`
- [ ] Doctor's state-marker check flags ALL intermediate statuses, not just `swap_done_redeploy_pending`
- [ ] `recommendOrRun` blocks on unresolved intermediate state with explorer URLs + resume hint
- [ ] Don't re-plan in-line from partial state — let operator re-run and re-plan from current ratio

### Add-liquidity mid-cycle
- [ ] `active-bin-tolerance` = `noneCV()` mid-cycle (avoids `ERR_ACTIVE_BIN_TOLERANCE u5008` race)
- [ ] Per-bin reserve derivation (`userShares × poolReserveX / poolLiquidity`) when App API returns reserve_x/reserve_y as 0
- [ ] Signed bin ID aware (tx results return `bin_id − CENTER_BIN_ID`; API uses unsigned)

---

# 5. WINNING LOGIC (5 WINS)

## Day 3 — hodlmm-bin-guardian (Read)

First skill combining live pool state + wallet position + price slippage → actionable recommendation.

- Slippage gate: HODLMM bin price vs Bitflow app price, block if > 0.5%
- Position health: in-range detection, drift, bin-by-bin reserve estimation
- doctor command: pre-flight API/wallet/dependency check
- Refusal reasons array: return ALL blockers, not just the first

## Day 4 — hermetica-yield-rotator (Write)

Only skill closing the full yield-execution loop: assess → stake → unstake → rotate.

- Cross-protocol rotation: compare Hermetica APY vs HODLMM APR
- Spend cap: `MAX_AUTONOMOUS_STAKE_USDH = 500`
- State machine: last action, unstake timestamp, exchange rate baseline — persists across runs
- APY from exchange rate drift, not hardcoded
- 5 actions: assess, stake, initiate-unstake, complete-unstake, rotate
- Post-conditions on every write path

## Day 13 — stacks-alpha-engine (Write, PR #485 merged + upstream #339 APPROVED)

Multi-protocol DeFi executor: Scout → Reserve → Guardian → Executor across Zest, Hermetica, Granite, HODLMM.

- 4-protocol yield routing with YTG (yield-to-go) ratios across 3 tiers: deploy-now / swap-first / acquire-to-unlock
- sBTC Proof-of-Reserve via BIP-341 P2TR derivation + Hiro peg read + GREEN/YELLOW/RED signal gates
- 5 Guardian gates: slippage, volume, gas, cooldown, price-source
- 11-test doctor including cryptographic vector verification
- 6 commands: doctor, scan, deploy, withdraw, rebalance, migrate, emergency
- Post-condition discipline: `allow` + sender-pin on routable fee flows, `deny` where unambiguous (Granite `redeem` lte cap + wallet `gte:"1"` floor)
- State persistence: last_rebalance_at, swap_pending for mid-cycle recovery
- Upstream registry PR aibtcdev/skills#339 APPROVED by @arc0btc — quoted as "the most thorough safety architecture" in BFF competition
- Resubmit #485 merged 2026-04-18 00:46 UTC (winner-approved + DAY 13 labels)

## Day 14 — HODLMM Move-Liquidity & Auto-Rebalancer (Write, 5/5 Fidelity)

First and only write-capable HODLMM rebalancer. Atomic. Autonomous.

- Atomic: single `move-relative-liquidity-multi` — "the correct approach"
- Directional bins: below → [-spread, 0], above → [0, +spread]
- 5 commands: doctor, scan, run, auto, install-packs
- auto: 24/7 loop, per-pool cooldown (4h disk), interval (min 5m), drift threshold, --once, --max-moves, SIGINT/SIGTERM
- DLP slippage: 95% min-dlp, 5% fee caps — reverts on-chain
- --force (recenter in-range), --spread (±1 to ±10)
- Gas check, wallet mismatch check
- Zero doc/code mismatches

## Day 24 — HODLMM Inventory Balancer (Write, PR #494, winner-approved + arc0btc-validated + hodlmm-bonus)

Target-ratio drift corrector for HODLMM LP composition. Two modes: default (tempo corrector) and opt-in 3-leg (full balancer).

- **Default mode** — swap + `hodlmm-move-liquidity` bin-to-bin recenter. Works when starting position is already near-band and corrective swap is material to LP size. Cycle 1 proof on dlmm_1: ratio 14.58% → 27.05% X (+12.47pp).
- **`--allow-rebalance-withdraw` mode** — 3-leg `withdraw-slice → swap → redeposit`. Fills the v1 gap: bin-to-bin recenter can't convert LP composition, but depositing wallet-side swap output via `add-relative-liquidity-same-multi` can. Live proof on dlmm_1: starting 0% X / 100% Y → **49.95% X / 50.05% Y, deviation 0.05%** via txs `89315a8b` + `5195822e` + `135f490c`. Within ±5% band — #493 acceptance criterion MET.
- Price-weighted ratio computation: each bin's contribution = `reserve × bin_price`; below-active bins are Y-only, above are X-only, active is mixed. Value in Y-units (raw) for comparison.
- Greedy multi-bin slice fill largest-first, per-bin cap at `REBALANCE_MAX_SLICE_BPS = 8000` (80% of user shares). List length ≤ 300 (router cap).
- Aggregate min-x/y-amount-total on withdraw for slippage gating; sender-pin + contract min-received on swap; `noneCV()` active-bin-tolerance on mid-cycle redeposit to avoid race aborts.
- Per-bin reserve derivation from `user_shares × pool_bin_reserves / pool_bin_liquidity` when App API reports raw per-bin reserves as 0.
- State markers: `swap_done_redeploy_pending` (v1), `withdraw_done_swap_pending`, `withdraw_done_swap_done_redeposit_pending` (3-leg) tagged with `last_cycle_mode`.
- Cross-tx sequencing: `waitForTxConfirmation` default 600s with 6s poll, `0x` prefix on Hiro tx lookups.
- Security: `--password` CLI flag REMOVED. `WALLET_PASSWORD` env var only (parent + child). Closes the `/proc/<pid>/cmdline` exposure class Arc/Diego flagged.
- Guardrails on 3-leg: gas reserve check for 3 txs (3× STX_GAS_FLOOR_USTX), mempool-depth guard on sender, quote-staleness gate, meta-cooldown (1h between cycles on same pool).
- 6 commands: install-packs, doctor, status, recommend, run, + 3-leg intermediate resume via re-run

## Day 15 — sbtc-capital-allocator (Write, PR #244 — pending)

Two-layer sBTC yield router: allocation + execution timing.

- Two-layer decision: WHERE (HODLMM vs Zest) + HOW (lump_sum vs DCA)
- DCA is an execution strategy, not a third yield protocol — controls entry timing based on risk signals
- 7d-smoothed HODLMM APY: `(feesUsd7d / 7) / tvlUsd * 365`, cross-validated against Bitflow `apr`
- Zest on-chain rate: `get-reserve-state` → `current-liquidity-rate` (1e6 precision, NOT 1e27)
- Pyth oracle two-tier gate: >2% = hard block, 1-2% = DCA mode
- Mempool whale tracking via Hiro API — catches repositioning before settlement
- LP range drift: active bin vs position bins, warning/critical
- Fee spike detection: 1d > 3x 7d avg = hard block
- TVL impact gate: deploy > 5% of pool TVL = blocked
- HODLMM write via `call_contract` + `add-relative-liquidity-multi` with computed args
- 6 commands: install-packs, doctor, scan, monitor, recommend, execute
- Both routes proven on mainnet: HODLMM tx `1a4b7bb5...`, Zest tx `fca71f20...`
- Proof follows skill's own recommendation (HODLMM at 12.84%), not manually chosen
- Competing PR #243 has no HODLMM write, no DCA, no whale tracking, no range drift, no fee spike detection

## Common Formula

1. **doctor → scan → run → auto** command progression
2. **Dry-run default** — `--confirm` + `--password` to execute
3. **auto = opt-in** — operator starts it, all safety still applies
4. **2+ mainnet proofs** — before/after, explorer links
5. **Contract-level protections** — enforce in tx params, not just docs
6. **State persisted to disk** — cooldowns, baselines survive restarts
7. **JSON-only output** — `{ status, action, data, error }` everywhere
8. **Commander.js** — judges check for this
9. **Post-conditions where possible** — justify Allow when needed
10. **Same-day review fixes** — push within hours, tag both judges
