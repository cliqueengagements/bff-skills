#!/usr/bin/env bun
/**
 * hodlmm-tenure-sentinel — Nakamoto tenure-aware risk monitor for HODLMM LPs.
 *
 * Monitors Bitcoin L1 block timing to detect "stale tenure" windows where
 * HODLMM LPs are exposed to toxic arbitrage flow. During tenure changes,
 * L2 prices can lag L1 reality — informed traders exploit this gap.
 *
 * This skill is the LP's circuit breaker: GREEN when safe, RED when exposed.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────────────

const HIRO_BASE = "https://api.mainnet.hiro.so";
const BITFLOW_POOLS = "https://bff.bitflowapis.finance/api/app/v1/pools";
const USER_AGENT = "bff-skills/hodlmm-tenure-sentinel";

// Tenure risk thresholds (seconds since last Bitcoin block)
const TENURE_GREEN_MAX_S = 600;     // 0–10 min: normal, safe
const TENURE_YELLOW_MAX_S = 900;    // 10–15 min: elevated, caution
const TENURE_RED_MAX_S = 1200;      // 15–20 min: high risk, widen bins
                                     // >20 min:   critical, consider exit

// HODLMM safety gates
const MIN_TVL_USD = 10_000;          // skip pools below this TVL
const MAX_SANE_APR = 500;            // reject implausible APR values
const STALE_TENURE_SPREAD_MULT = 2;  // recommend 2x bin width during RED
const CRITICAL_SPREAD_MULT = 3;      // recommend 3x bin width during CRITICAL

// Historical analysis window
const BURN_BLOCKS_HISTORY = 10;      // last 10 BTC blocks for timing stats

// Fetch timeout
const FETCH_TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────────────────

interface TenureStatus {
  burn_block_height: number;
  burn_block_time_iso: string;
  burn_block_time_unix: number;
  tenure_age_s: number;
  tenure_height: number;
  stacks_tip_height: number;
  stacks_blocks_in_tenure: number;
  risk_level: "GREEN" | "YELLOW" | "RED" | "CRITICAL";
  risk_description: string;
}

interface BlockTiming {
  burn_height: number;
  burn_time_iso: string;
  gap_s: number | null;
  stacks_blocks: number;
}

interface TimingStats {
  blocks: BlockTiming[];
  avg_gap_s: number;
  min_gap_s: number;
  max_gap_s: number;
  stddev_s: number;
  predicted_next_block_s: number;
}

interface PoolRisk {
  pool_id: string;
  pair: string;
  tvl_usd: number;
  apr: number;
  bin_step: number;
  base_fee: number;
  volume_24h_usd: number;
  current_spread_bps: number;
  recommended_spread_bps: number;
  spread_action: "HOLD" | "WIDEN" | "WIDEN_URGENT" | "EXIT_RISK";
  toxic_flow_exposure: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  rationale: string;
}

interface SentinelResult {
  status: "ok" | "degraded" | "error";
  decision: "SAFE" | "CAUTION" | "WIDEN" | "SHELTER";
  action: string;
  tenure: TenureStatus;
  timing: TimingStats;
  pools: PoolRisk[];
  sources_used: string[];
  sources_failed: string[];
  timestamp: string;
  error: string | null;
}

interface DoctorResult {
  status: "ok" | "degraded" | "error";
  checks: Record<string, "ok" | "fail">;
  message: string;
}

// ── Fetch helper ───────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1500));
      const retry = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (!retry.ok) throw new Error(`HTTP ${retry.status} from ${url} (after retry)`);
      return retry.json() as Promise<T>;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Data fetchers ──────────────────────────────────────────────────────────────

async function fetchNodeInfo(): Promise<any> {
  return fetchJson(`${HIRO_BASE}/v2/info`);
}

async function fetchLatestBlocks(limit = 5): Promise<any> {
  return fetchJson(`${HIRO_BASE}/extended/v2/blocks?limit=${limit}`);
}

async function fetchBurnBlocks(limit = BURN_BLOCKS_HISTORY): Promise<any> {
  return fetchJson(`${HIRO_BASE}/extended/v2/burn-blocks?limit=${limit}`);
}

async function fetchPools(): Promise<any[]> {
  const data = await fetchJson<any>(BITFLOW_POOLS);
  if (Array.isArray(data)) return data;
  if (data?.data) return data.data;
  if (data?.results) return data.results;
  if (data?.pools) return data.pools;
  return [];
}

async function fetchStxFees(): Promise<any> {
  return fetchJson(`${HIRO_BASE}/v2/fees/transfer`);
}

// ── Core logic ─────────────────────────────────────────────────────────────────

function classifyRisk(tenureAgeS: number): TenureStatus["risk_level"] {
  if (tenureAgeS <= TENURE_GREEN_MAX_S) return "GREEN";
  if (tenureAgeS <= TENURE_YELLOW_MAX_S) return "YELLOW";
  if (tenureAgeS <= TENURE_RED_MAX_S) return "RED";
  return "CRITICAL";
}

function riskDescription(level: TenureStatus["risk_level"], ageS: number): string {
  const ageMin = (ageS / 60).toFixed(1);
  switch (level) {
    case "GREEN":
      return `Tenure fresh (${ageMin}m). Bitcoin block recent — L2 prices aligned with L1. Normal bin spreads safe.`;
    case "YELLOW":
      return `Tenure aging (${ageMin}m). Approaching typical BTC block interval. Monitor for drift — no action yet.`;
    case "RED":
      return `Tenure stale (${ageMin}m). L2 prices may lag L1 reality. Arbitrageurs have informational edge. Widen bin spreads to reduce toxic flow exposure.`;
    case "CRITICAL":
      return `Tenure critically stale (${ageMin}m). High probability of tenure change imminent. Maximum toxic flow risk — widen to outer bins or pause new deployments.`;
  }
}

function computeTenureStatus(nodeInfo: any, latestBlock: any, burnBlockData: any): TenureStatus {
  const burnTime = latestBlock.burn_block_time;
  const burnTimeIso = latestBlock.burn_block_time_iso;
  const nowUnix = Math.floor(Date.now() / 1000);
  const tenureAgeS = nowUnix - burnTime;

  // Count stacks blocks in current tenure from burn-blocks data
  let stacksBlocksInTenure = 0;
  if (burnBlockData?.results?.[0]?.stacks_blocks) {
    stacksBlocksInTenure = burnBlockData.results[0].stacks_blocks.length;
  }

  const riskLevel = classifyRisk(tenureAgeS);

  return {
    burn_block_height: latestBlock.burn_block_height,
    burn_block_time_iso: burnTimeIso,
    burn_block_time_unix: burnTime,
    tenure_age_s: tenureAgeS,
    tenure_height: nodeInfo.tenure_height ?? latestBlock.tenure_height,
    stacks_tip_height: nodeInfo.stacks_tip_height ?? latestBlock.height,
    stacks_blocks_in_tenure: stacksBlocksInTenure,
    risk_level: riskLevel,
    risk_description: riskDescription(riskLevel, tenureAgeS),
  };
}

function computeTimingStats(burnBlocks: any[]): TimingStats {
  const blocks: BlockTiming[] = [];
  const gaps: number[] = [];

  for (let i = 0; i < burnBlocks.length; i++) {
    const bb = burnBlocks[i];
    const burnTime = bb.burn_block_time ?? bb.burn_block_time_unix;
    const burnTimeIso = bb.burn_block_time_iso ?? new Date(burnTime * 1000).toISOString();
    const stacksBlocks = bb.stacks_blocks?.length ?? 0;
    let gapS: number | null = null;

    if (i < burnBlocks.length - 1) {
      const prevBb = burnBlocks[i + 1];
      const prevTime = prevBb.burn_block_time ?? prevBb.burn_block_time_unix;
      gapS = burnTime - prevTime;
      if (gapS > 0) gaps.push(gapS);
    }

    blocks.push({
      burn_height: bb.burn_block_height,
      burn_time_iso: burnTimeIso,
      gap_s: gapS,
      stacks_blocks: stacksBlocks,
    });
  }

  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 600;
  const minGap = gaps.length > 0 ? Math.min(...gaps) : 0;
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;
  const variance = gaps.length > 0
    ? gaps.reduce((sum, g) => sum + (g - avgGap) ** 2, 0) / gaps.length
    : 0;
  const stddev = Math.sqrt(variance);

  return {
    blocks,
    avg_gap_s: Math.round(avgGap),
    min_gap_s: minGap,
    max_gap_s: maxGap,
    stddev_s: Math.round(stddev),
    predicted_next_block_s: Math.round(avgGap),
  };
}

function assessPoolRisk(pool: any, tenure: TenureStatus): PoolRisk | null {
  const tvl = typeof pool.tvlUsd === "number" ? pool.tvlUsd : parseFloat(pool.tvlUsd ?? "0");
  const apr = typeof pool.apr === "number" ? pool.apr : parseFloat(pool.apr ?? "0");
  const binStep = typeof pool.binStep === "number" ? pool.binStep : parseFloat(pool.binStep ?? "10");
  const baseFee = typeof pool.baseFee === "number" ? pool.baseFee : parseFloat(pool.baseFee ?? "0.003");
  const vol24h = typeof pool.volumeUsd1d === "number" ? pool.volumeUsd1d : parseFloat(pool.volumeUsd1d ?? "0");
  const poolId = pool.poolId ?? pool.pool_id ?? "unknown";

  // Skip tiny or implausible pools
  if (tvl < MIN_TVL_USD) return null;
  if (apr > MAX_SANE_APR) return null;

  const tokenX = pool.tokens?.tokenX?.symbol ?? pool.poolComposition?.tokenX?.symbol ?? "?";
  const tokenY = pool.tokens?.tokenY?.symbol ?? pool.poolComposition?.tokenY?.symbol ?? "?";
  const pair = `${tokenX}/${tokenY}`;

  const currentSpreadBps = binStep;
  let recommendedSpreadBps = currentSpreadBps;
  let spreadAction: PoolRisk["spread_action"] = "HOLD";
  let toxicExposure: PoolRisk["toxic_flow_exposure"] = "LOW";
  let rationale = "";

  // Higher volume pools are more attractive targets for toxic flow
  const isHighVolume = vol24h > 50_000;
  const isMediumVolume = vol24h > 10_000;

  switch (tenure.risk_level) {
    case "GREEN":
      spreadAction = "HOLD";
      toxicExposure = "LOW";
      rationale = isHighVolume
        ? "Tenure fresh — normal spreads safe. High volume but low arb risk during fresh tenure."
        : "Tenure fresh — normal spreads safe.";
      break;

    case "YELLOW":
      if (isHighVolume) {
        toxicExposure = "MODERATE";
        rationale = "Tenure aging with high volume — arbitrageurs may begin positioning. Monitor closely.";
      } else {
        toxicExposure = "LOW";
        rationale = "Tenure aging but low volume reduces arb incentive. Hold current spreads.";
      }
      spreadAction = "HOLD";
      break;

    case "RED":
      recommendedSpreadBps = currentSpreadBps * STALE_TENURE_SPREAD_MULT;
      if (isHighVolume) {
        spreadAction = "WIDEN_URGENT";
        toxicExposure = "HIGH";
        rationale = `Stale tenure + high volume ($${vol24h.toFixed(0)}/24h) = prime arb target. Widen bins to ${recommendedSpreadBps} bps immediately.`;
      } else if (isMediumVolume) {
        spreadAction = "WIDEN";
        toxicExposure = "MODERATE";
        rationale = `Stale tenure with moderate volume. Widen bins to ${recommendedSpreadBps} bps as precaution.`;
      } else {
        spreadAction = "HOLD";
        toxicExposure = "LOW";
        rationale = "Stale tenure but thin volume — arb cost exceeds profit. Spreads can hold.";
      }
      break;

    case "CRITICAL":
      recommendedSpreadBps = currentSpreadBps * CRITICAL_SPREAD_MULT;
      if (isHighVolume || isMediumVolume) {
        spreadAction = "EXIT_RISK";
        toxicExposure = "CRITICAL";
        rationale = `Critically stale tenure (${(tenure.tenure_age_s / 60).toFixed(0)}m) — tenure change imminent. High toxic flow probability. Move to outer bins (${recommendedSpreadBps} bps) or pause deployments.`;
      } else {
        spreadAction = "WIDEN";
        toxicExposure = "HIGH";
        rationale = `Critically stale tenure but thin volume. Widen to ${recommendedSpreadBps} bps as defensive measure.`;
      }
      break;
  }

  return {
    pool_id: poolId,
    pair,
    tvl_usd: tvl,
    apr,
    bin_step: binStep,
    base_fee: baseFee,
    volume_24h_usd: vol24h,
    current_spread_bps: currentSpreadBps,
    recommended_spread_bps: recommendedSpreadBps,
    spread_action: spreadAction,
    toxic_flow_exposure: toxicExposure,
    rationale,
  };
}

function overallDecision(tenure: TenureStatus, pools: PoolRisk[]): { decision: SentinelResult["decision"]; action: string } {
  const hasExitRisk = pools.some(p => p.spread_action === "EXIT_RISK");
  const hasWidenUrgent = pools.some(p => p.spread_action === "WIDEN_URGENT");
  const hasWiden = pools.some(p => p.spread_action === "WIDEN");
  const hasModerate = pools.some(p => p.toxic_flow_exposure === "MODERATE");

  if (hasExitRisk) {
    return {
      decision: "SHELTER",
      action: `CRITICAL: Tenure stale ${(tenure.tenure_age_s / 60).toFixed(0)}m — move HODLMM liquidity to outer bins or pause. Tenure change imminent, toxic flow risk maximum.`,
    };
  }

  if (hasWidenUrgent) {
    return {
      decision: "WIDEN",
      action: `WARNING: Stale tenure (${(tenure.tenure_age_s / 60).toFixed(0)}m) with active volume. Widen bin spreads on high-volume pools to reduce arb exposure.`,
    };
  }

  if (hasWiden) {
    return {
      decision: "CAUTION",
      action: `Tenure aging (${(tenure.tenure_age_s / 60).toFixed(0)}m). Consider widening spreads on exposed pools. New Bitcoin block expected within ${Math.max(0, Math.round((600 - tenure.tenure_age_s) / 60))}m.`,
    };
  }

  // Tenure is YELLOW/RED but no pool needs widening yet — still flag caution
  if (tenure.risk_level === "YELLOW" && hasModerate) {
    return {
      decision: "CAUTION",
      action: `Tenure aging (${(tenure.tenure_age_s / 60).toFixed(0)}m). High-volume pools showing moderate toxic flow exposure. Monitor — no spread change yet.`,
    };
  }

  if (tenure.risk_level === "RED" || tenure.risk_level === "CRITICAL") {
    return {
      decision: "CAUTION",
      action: `Tenure stale (${(tenure.tenure_age_s / 60).toFixed(0)}m) but pool volume too thin for profitable arb. Monitor closely — risk escalates if volume spikes.`,
    };
  }

  return {
    decision: "SAFE",
    action: `Tenure fresh (${(tenure.tenure_age_s / 60).toFixed(0)}m). All HODLMM positions safe at current spreads. No action required.`,
  };
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  const checks: Record<string, "ok" | "fail"> = {};
  const sources = [
    { name: "hiro_node_info", url: `${HIRO_BASE}/v2/info` },
    { name: "hiro_blocks", url: `${HIRO_BASE}/extended/v2/blocks?limit=1` },
    { name: "hiro_burn_blocks", url: `${HIRO_BASE}/extended/v2/burn-blocks?limit=1` },
    { name: "bitflow_pools", url: BITFLOW_POOLS },
    { name: "hiro_fees", url: `${HIRO_BASE}/v2/fees/transfer` },
  ];

  for (const src of sources) {
    try {
      await fetchJson(src.url);
      checks[src.name] = "ok";
    } catch {
      checks[src.name] = "fail";
    }
  }

  const allOk = Object.values(checks).every(v => v === "ok");
  const noneOk = Object.values(checks).every(v => v === "fail");

  const result: DoctorResult = {
    status: noneOk ? "error" : allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All 5 data sources reachable. Tenure sentinel ready."
      : noneOk
        ? "All data sources unreachable. Check network connectivity."
        : `Some sources degraded: ${Object.entries(checks).filter(([, v]) => v === "fail").map(([k]) => k).join(", ")}`,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(allOk ? 0 : noneOk ? 3 : 1);
}

async function runSentinel(opts: { pool?: string; verbose?: boolean }): Promise<void> {
  const sourcesUsed: string[] = [];
  const sourcesFailed: string[] = [];
  const now = new Date().toISOString();

  // Fetch all data sources in parallel
  let nodeInfo: any, blocksData: any, burnData: any, pools: any[], feesData: any;

  try {
    [nodeInfo, blocksData, burnData, pools, feesData] = await Promise.all([
      fetchNodeInfo().then(d => { sourcesUsed.push("hiro-node-info"); return d; })
        .catch(e => { sourcesFailed.push("hiro-node-info"); return null; }),
      fetchLatestBlocks(1).then(d => { sourcesUsed.push("hiro-blocks"); return d; })
        .catch(e => { sourcesFailed.push("hiro-blocks"); return null; }),
      fetchBurnBlocks().then(d => { sourcesUsed.push("hiro-burn-blocks"); return d; })
        .catch(e => { sourcesFailed.push("hiro-burn-blocks"); return null; }),
      fetchPools().then(d => { sourcesUsed.push("bitflow-hodlmm"); return d; })
        .catch(e => { sourcesFailed.push("bitflow-hodlmm"); return []; }),
      fetchStxFees().then(d => { sourcesUsed.push("hiro-fees"); return d; })
        .catch(e => { sourcesFailed.push("hiro-fees"); return null; }),
    ]);
  } catch (err: any) {
    const errorResult: SentinelResult = {
      status: "error",
      decision: "SHELTER",
      action: "Data sources unavailable — assume maximum risk. Do not deploy new liquidity.",
      tenure: {
        burn_block_height: 0,
        burn_block_time_iso: "",
        burn_block_time_unix: 0,
        tenure_age_s: 9999,
        tenure_height: 0,
        stacks_tip_height: 0,
        stacks_blocks_in_tenure: 0,
        risk_level: "CRITICAL",
        risk_description: "Unable to determine tenure status — defaulting to maximum risk.",
      },
      timing: { blocks: [], avg_gap_s: 0, min_gap_s: 0, max_gap_s: 0, stddev_s: 0, predicted_next_block_s: 0 },
      pools: [],
      sources_used: sourcesUsed,
      sources_failed: sourcesFailed,
      timestamp: now,
      error: err.message,
    };
    console.log(JSON.stringify(errorResult, null, 2));
    process.exit(3);
    return;
  }

  // Must have blocks data for tenure calculation
  if (!blocksData?.results?.[0] && !nodeInfo) {
    const errorResult: SentinelResult = {
      status: "error",
      decision: "SHELTER",
      action: "Cannot determine tenure age — defaulting to SHELTER. Do not deploy.",
      tenure: {
        burn_block_height: 0, burn_block_time_iso: "", burn_block_time_unix: 0,
        tenure_age_s: 9999, tenure_height: 0, stacks_tip_height: 0,
        stacks_blocks_in_tenure: 0, risk_level: "CRITICAL",
        risk_description: "Block data unavailable — maximum risk assumed.",
      },
      timing: { blocks: [], avg_gap_s: 0, min_gap_s: 0, max_gap_s: 0, stddev_s: 0, predicted_next_block_s: 0 },
      pools: [],
      sources_used: sourcesUsed,
      sources_failed: sourcesFailed,
      timestamp: now,
      error: "No block data available",
    };
    console.log(JSON.stringify(errorResult, null, 2));
    process.exit(3);
    return;
  }

  const latestBlock = blocksData?.results?.[0];

  // Compute tenure status
  const tenure = computeTenureStatus(nodeInfo ?? {}, latestBlock, burnData);

  // Compute timing stats from burn block history
  const burnBlocks = burnData?.results ?? [];
  const timing = computeTimingStats(burnBlocks);

  // Assess each HODLMM pool
  let dlmmPools = pools.filter((p: any) => {
    const id = p.poolId ?? p.pool_id ?? "";
    const tvl = typeof p.tvlUsd === "number" ? p.tvlUsd : parseFloat(p.tvlUsd ?? "0");
    return id.startsWith("dlmm_") && tvl >= MIN_TVL_USD;
  });

  // Filter to specific pool if requested
  if (opts.pool) {
    dlmmPools = dlmmPools.filter((p: any) =>
      (p.poolId ?? p.pool_id ?? "").toLowerCase() === opts.pool!.toLowerCase()
    );
  }

  const poolRisks: PoolRisk[] = [];
  for (const pool of dlmmPools) {
    const risk = assessPoolRisk(pool, tenure);
    if (risk) poolRisks.push(risk);
  }

  // Sort: highest risk first
  const riskOrder = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };
  poolRisks.sort((a, b) => riskOrder[a.toxic_flow_exposure] - riskOrder[b.toxic_flow_exposure]);

  // Overall decision
  const { decision, action } = overallDecision(tenure, poolRisks);

  const result: SentinelResult = {
    status: sourcesFailed.length === 0 ? "ok" : "degraded",
    decision,
    action,
    tenure,
    timing: opts.verbose ? timing : {
      ...timing,
      blocks: timing.blocks.slice(0, 5), // limit to 5 most recent in non-verbose
    },
    pools: poolRisks,
    sources_used: sourcesUsed,
    sources_failed: sourcesFailed,
    timestamp: now,
    error: null,
  };

  console.log(JSON.stringify(result, null, 2));

  // Exit code based on risk
  if (decision === "SHELTER") process.exit(2);
  if (decision === "WIDEN") process.exit(1);
  process.exit(0);
}

// ── Exportable core function ───────────────────────────────────────────────────

export async function assessTenureRisk(pool?: string): Promise<SentinelResult> {
  const sourcesUsed: string[] = [];
  const sourcesFailed: string[] = [];

  const [nodeInfo, blocksData, burnData, pools] = await Promise.all([
    fetchNodeInfo().then(d => { sourcesUsed.push("hiro-node-info"); return d; })
      .catch(() => { sourcesFailed.push("hiro-node-info"); return null; }),
    fetchLatestBlocks(1).then(d => { sourcesUsed.push("hiro-blocks"); return d; })
      .catch(() => { sourcesFailed.push("hiro-blocks"); return null; }),
    fetchBurnBlocks().then(d => { sourcesUsed.push("hiro-burn-blocks"); return d; })
      .catch(() => { sourcesFailed.push("hiro-burn-blocks"); return null; }),
    fetchPools().then(d => { sourcesUsed.push("bitflow-hodlmm"); return d; })
      .catch(() => { sourcesFailed.push("bitflow-hodlmm"); return []; }),
  ]);

  if (!blocksData?.results?.[0]) {
    return {
      status: "error", decision: "SHELTER",
      action: "Cannot read block data — assume max risk.",
      tenure: {
        burn_block_height: 0, burn_block_time_iso: "", burn_block_time_unix: 0,
        tenure_age_s: 9999, tenure_height: 0, stacks_tip_height: 0,
        stacks_blocks_in_tenure: 0, risk_level: "CRITICAL",
        risk_description: "Data unavailable.",
      },
      timing: { blocks: [], avg_gap_s: 0, min_gap_s: 0, max_gap_s: 0, stddev_s: 0, predicted_next_block_s: 0 },
      pools: [], sources_used: sourcesUsed, sources_failed: sourcesFailed,
      timestamp: new Date().toISOString(), error: "No block data",
    };
  }

  const tenure = computeTenureStatus(nodeInfo ?? {}, blocksData.results[0], burnData);
  const timing = computeTimingStats(burnData?.results ?? []);

  let dlmmPools = (pools as any[]).filter((p: any) =>
    (p.type === "DLMM" || p.poolType === "DLMM") && parseFloat(p.tvlUsd ?? "0") >= MIN_TVL_USD
  );
  if (pool) dlmmPools = dlmmPools.filter((p: any) => (p.poolId ?? "").toLowerCase() === pool.toLowerCase());

  const poolRisks = dlmmPools.map(p => assessPoolRisk(p, tenure)).filter(Boolean) as PoolRisk[];
  const { decision, action } = overallDecision(tenure, poolRisks);

  return {
    status: sourcesFailed.length === 0 ? "ok" : "degraded",
    decision, action, tenure, timing, pools: poolRisks,
    sources_used: sourcesUsed, sources_failed: sourcesFailed,
    timestamp: new Date().toISOString(), error: null,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-tenure-sentinel")
  .description("Nakamoto tenure-aware risk monitor for HODLMM concentrated liquidity positions")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify all data sources are reachable")
  .action(runDoctor);

program
  .command("install-packs")
  .description("No additional packs required")
  .action(() => {
    console.log(JSON.stringify({ status: "ok", message: "No additional packs required. Uses native fetch for all API calls." }));
  });

program
  .command("run")
  .description("Assess current tenure risk for HODLMM positions")
  .option("--pool <id>", "Filter to specific HODLMM pool (e.g., dlmm_1)")
  .option("--verbose", "Include full burn block history in output")
  .action(runSentinel);

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: any) => {
    console.error(JSON.stringify({
      status: "error",
      decision: "SHELTER",
      action: "Unhandled error — assume maximum risk.",
      error: err.message,
    }));
    process.exit(3);
  });
}
