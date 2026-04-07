#!/usr/bin/env bun
/**
 * hodlmm-move-liquidity — Move idle HODLMM liquidity back into earning range.
 *
 * When the active bin drifts away from your LP position, this skill withdraws
 * liquidity from the old bins and re-deposits it into bins centered on the
 * current active bin. Two on-chain transactions: withdraw then deposit.
 *
 * Commands:
 *   doctor        — check APIs, wallet, pool access
 *   scan          — show positions and in-range status across pools
 *   run           — assess + execute rebalance (dry-run unless --confirm)
 *   install-packs — no-op
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const BIN_SPREAD = 5; // ±5 bins around active bin = up to 11 bins
const FETCH_TIMEOUT = 30_000;

const STATE_FILE = path.join(os.homedir(), ".hodlmm-move-liquidity-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
}

interface UserBin {
  bin_id: number;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface PositionHealth {
  pool_id: string;
  pair: string;
  active_bin: number;
  user_bins: number[];
  user_bin_min: number;
  user_bin_max: number;
  in_range: boolean;
  drift: number;
  total_x: string;
  total_y: string;
  total_dlp: string;
}

interface CooldownState {
  [poolId: string]: { last_move_at: string };
}

// ─── Output helper ────────────────────────────────────────────────────────────

function out(status: string, action: string, data: unknown, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: unknown[]): void {
  process.stderr.write(`[move-liquidity] ${args.join(" ")}\n`);
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } =
      await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } =
    await import("@stacks/wallet-sdk" as string);

  if (fs.existsSync(WALLETS_FILE)) {
    const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const activeWallet = (walletsJson.wallets ?? [])[0];
    if (activeWallet?.id) {
      const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
      if (fs.existsSync(keystorePath)) {
        const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
        const enc = keystore.encrypted;
        if (enc?.ciphertext) {
          const { scryptSync, createDecipheriv } = await import("crypto");
          const salt = Buffer.from(enc.salt, "base64");
          const iv = Buffer.from(enc.iv, "base64");
          const authTag = Buffer.from(enc.authTag, "base64");
          const ciphertext = Buffer.from(enc.ciphertext, "base64");
          const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
            N: enc.scryptParams?.N ?? 16384,
            r: enc.scryptParams?.r ?? 8,
            p: enc.scryptParams?.p ?? 1,
          });
          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(authTag);
          const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8").trim();
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
        const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
        if (legacyEnc) {
          const { decryptMnemonic } = await import("@stacks/encryption" as string);
          const mnemonic = await decryptMnemonic(legacyEnc, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
      }
    }
  }
  throw new Error("No wallet found. Run: npx @aibtc/mcp-server@latest --install");
}

// ─── Bitflow API reads ────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  const raw = await fetchJson<{ data?: unknown[]; results?: unknown[]; pools?: unknown[]; [k: string]: unknown }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  const list = (raw.data ?? raw.results ?? raw.pools ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  return list.map((p) => ({
    pool_id: String(p.pool_id ?? p.poolId ?? ""),
    pool_contract: String(p.pool_token ?? p.poolContract ?? p.core_address ?? ""),
    token_x: String(p.token_x ?? (p as Record<string, Record<string, string>>).tokens?.tokenX?.contract ?? ""),
    token_y: String(p.token_y ?? (p as Record<string, Record<string, string>>).tokens?.tokenY?.contract ?? ""),
    token_x_symbol: String(p.token_x_symbol ?? (p as Record<string, Record<string, string>>).tokens?.tokenX?.symbol ?? "?"),
    token_y_symbol: String(p.token_y_symbol ?? (p as Record<string, Record<string, string>>).tokens?.tokenY?.symbol ?? "?"),
    token_x_decimals: Number(p.token_x_decimals ?? (p as Record<string, Record<string, string>>).tokens?.tokenX?.decimals ?? 8),
    token_y_decimals: Number(p.token_y_decimals ?? (p as Record<string, Record<string, string>>).tokens?.tokenY?.decimals ?? 6),
    active_bin: Number(p.active_bin ?? p.activeBin ?? 0),
    bin_step: Number(p.bin_step ?? p.binStep ?? 0),
  }));
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[] }> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  const activeBin = Number(raw.active_bin_id ?? raw.activeBinId ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id ?? b.binId),
    reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
    reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? b.bin_shares ?? "0"),
  }));
  return { active_bin_id: activeBin, bins };
}

async function fetchUserPositions(poolId: string, wallet: string): Promise<UserBin[]> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
  );
  const bins = (raw.bins ?? raw.position_bins ?? (raw as Record<string, Record<string, unknown>>).positions?.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => {
      const liq = BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0"));
      return liq > 0n;
    })
    .map((b) => ({
      bin_id: Number(b.bin_id ?? b.binId),
      liquidity: String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
      reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
      price: String(b.price ?? "0"),
    }));
}

async function fetchStxBalance(wallet: string): Promise<number> {
  const data = await fetchJson<Record<string, string>>(
    `${HIRO_API}/extended/v1/address/${wallet}/stx`
  );
  return Number(BigInt(data?.balance ?? "0")) / 1e6;
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/nonces`
  );
  const possible = Number(data.possible_next_nonce ?? data.last_executed_tx_nonce ?? 0);
  return BigInt(possible);
}

// ─── Position assessment ──────────────────────────────────────────────────────

function assessPosition(pool: PoolMeta, userBins: UserBin[], activeBin: number, poolBins?: BinData[]): PositionHealth {
  const ids = userBins.map((b) => b.bin_id).sort((a, b) => a - b);
  const inRange = ids.length > 0 && activeBin >= ids[0] && activeBin <= ids[ids.length - 1];
  const center = ids.length > 0 ? Math.round((ids[0] + ids[ids.length - 1]) / 2) : activeBin;
  const drift = Math.abs(activeBin - center);

  // Build a map of pool-level bin data for reserve estimation
  const poolBinMap = new Map((poolBins ?? []).map((b) => [b.bin_id, b]));

  let totalX = 0n;
  let totalY = 0n;
  let totalDlp = 0n;
  for (const b of userBins) {
    const dlp = BigInt(b.liquidity);
    totalDlp += dlp;

    // If user position has reserve data, use it; otherwise estimate from pool bins
    const rx = BigInt(b.reserve_x);
    const ry = BigInt(b.reserve_y);
    if (rx > 0n || ry > 0n) {
      totalX += rx;
      totalY += ry;
    } else {
      // Estimate: user_share = user_dlp / pool_dlp * pool_reserves
      const pb = poolBinMap.get(b.bin_id);
      if (pb && dlp > 0n) {
        const poolDlp = BigInt(pb.liquidity || "1");
        if (poolDlp > 0n) {
          totalX += (dlp * BigInt(pb.reserve_x)) / poolDlp;
          totalY += (dlp * BigInt(pb.reserve_y)) / poolDlp;
        }
      }
    }
  }

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin: activeBin,
    user_bins: ids,
    user_bin_min: ids[0] ?? 0,
    user_bin_max: ids[ids.length - 1] ?? 0,
    in_range: inRange,
    drift,
    total_x: totalX.toString(),
    total_y: totalY.toString(),
    total_dlp: totalDlp.toString(),
  };
}

// ─── Build withdrawal + deposit plans ─────────────────────────────────────────

function buildWithdrawPositions(userBins: UserBin[], activeBin: number) {
  return userBins.map((b) => ({
    activeBinOffset: b.bin_id - activeBin,
    amount: b.liquidity,
    // Contract requires min-x + min-y > 0 (ERR_INVALID_AMOUNT u1002)
    minXAmount: "0",
    minYAmount: "1",
  }));
}

function buildDepositBins(totalX: bigint, totalY: bigint, spread: number) {
  const bins: { activeBinOffset: number; xAmount: string; yAmount: string }[] = [];
  if (totalX === 0n && totalY === 0n) return bins;

  // Bins above active: X only (+1 to +spread)
  // Active bin (0): both X and Y
  // Bins below active: Y only (-spread to -1)
  const xSlots = spread + 1; // active + above
  const ySlots = spread + 1; // active + below
  const xPerBin = totalX / BigInt(xSlots);
  const yPerBin = totalY / BigInt(ySlots);

  // Below active: Y only
  for (let i = -spread; i < 0; i++) {
    if (yPerBin > 0n) bins.push({ activeBinOffset: i, xAmount: "0", yAmount: yPerBin.toString() });
  }

  // Active bin: both
  bins.push({
    activeBinOffset: 0,
    xAmount: xPerBin.toString(),
    yAmount: yPerBin.toString(),
  });

  // Above active: X only
  for (let i = 1; i <= spread; i++) {
    if (xPerBin > 0n) bins.push({ activeBinOffset: i, xAmount: xPerBin.toString(), yAmount: "0" });
  }

  return bins;
}

// ─── On-chain execution ───────────────────────────────────────────────────────

async function executeWithdraw(
  privateKey: string,
  pool: PoolMeta,
  positions: { activeBinOffset: number; amount: string; minXAmount: string; minYAmount: string }[],
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV,
    PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const withdrawList = positions.map((p) =>
    tupleCV({
      "active-bin-id-offset": intCV(p.activeBinOffset),
      amount: uintCV(BigInt(p.amount)),
      "min-x-amount": uintCV(BigInt(p.minXAmount)),
      "min-y-amount": uintCV(BigInt(p.minYAmount)),
      "pool-trait": contractPrincipalCV(poolAddr, poolName),
    })
  );

  const totalMinX = positions.reduce((s, p) => s + BigInt(p.minXAmount), 0n);
  const totalMinY = positions.reduce((s, p) => s + BigInt(p.minYAmount), 0n);

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "withdraw-relative-liquidity-same-multi",
    functionArgs: [
      listCV(withdrawList),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      uintCV(totalMinX),
      uintCV(totalMinY),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditions: [],
    // DLP burns + token returns cannot be expressed as sender-side post-conditions
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Withdraw broadcast failed: ${result.error} — ${result.reason ?? ""}`);
  }
  return result.txid as string;
}

async function executeDeposit(
  privateKey: string,
  pool: PoolMeta,
  bins: { activeBinOffset: number; xAmount: string; yAmount: string }[],
  activeBin: number,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV,
    someCV, PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const binAddList = bins.map((b) =>
    tupleCV({
      "active-bin-id-offset": intCV(b.activeBinOffset),
      "x-amount": uintCV(BigInt(b.xAmount)),
      "y-amount": uintCV(BigInt(b.yAmount)),
      "min-dlp": uintCV(1n),
      "max-x-liquidity-fee": uintCV(BigInt(b.xAmount)),
      "max-y-liquidity-fee": uintCV(BigInt(b.yAmount)),
    })
  );

  // Active-bin-tolerance: reject if bin moved more than ±2 from expected
  const tolerance = someCV(
    tupleCV({
      "expected-bin-id": intCV(activeBin - 500),
      "max-deviation": uintCV(2n),
    })
  );

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "add-relative-liquidity-same-multi",
    functionArgs: [
      listCV(binAddList),
      contractPrincipalCV(poolAddr, poolName),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      tolerance,
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditions: [],
    // DLP mints cannot be expressed as sender-side post-conditions
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Deposit broadcast failed: ${result.error} — ${result.reason ?? ""}`);
  }
  return result.txid as string;
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState(): CooldownState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as CooldownState;
  } catch {
    return {};
  }
}

function saveState(state: CooldownState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cooldownRemaining(state: CooldownState, poolId: string): number {
  const entry = state[poolId];
  if (!entry) return 0;
  const elapsed = Date.now() - new Date(entry.last_move_at).getTime();
  return Math.max(0, COOLDOWN_MS - elapsed);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-move-liquidity").description("Move idle HODLMM liquidity back into earning range");

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check API access, wallet, and pool readiness")
  .option("--wallet <address>", "STX address to check")
  .action(async (opts) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    try {
      const pools = await fetchPools();
      checks.bitflow_pools = { ok: pools.length > 0, detail: `${pools.length} HODLMM pools found` };
    } catch (e: unknown) {
      checks.bitflow_pools = { ok: false, detail: (e as Error).message };
    }

    try {
      const data = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/dlmm_1`);
      checks.bitflow_bins = { ok: !!data.active_bin_id || !!data.activeBinId, detail: `active_bin=${data.active_bin_id ?? data.activeBinId}` };
    } catch (e: unknown) {
      checks.bitflow_bins = { ok: false, detail: (e as Error).message };
    }

    try {
      const info = await fetchJson<Record<string, unknown>>(`${HIRO_API}/v2/info`);
      checks.hiro_api = { ok: !!info.stacks_tip_height, detail: `tip=${info.stacks_tip_height}` };
    } catch (e: unknown) {
      checks.hiro_api = { ok: false, detail: (e as Error).message };
    }

    if (opts.wallet) {
      try {
        const bal = await fetchStxBalance(opts.wallet);
        checks.stx_balance = { ok: bal > 0, detail: `${bal.toFixed(2)} STX` };
      } catch (e: unknown) {
        checks.stx_balance = { ok: false, detail: (e as Error).message };
      }
    }

    try {
      await import("@stacks/transactions" as string);
      checks.stacks_tx_lib = { ok: true, detail: "available" };
    } catch {
      checks.stacks_tx_lib = { ok: false, detail: "@stacks/transactions not installed" };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    out(allOk ? "success" : "degraded", "doctor", { checks });
  });

// ── scan ──────────────────────────────────────────────────────────────────────

program
  .command("scan")
  .description("Show position health across all HODLMM pools")
  .requiredOption("--wallet <address>", "STX address")
  .action(async (opts) => {
    try {
      const pools = await fetchPools();
      const positions: PositionHealth[] = [];

      for (const pool of pools) {
        try {
          const [userBins, binsData] = await Promise.all([
            fetchUserPositions(pool.pool_id, opts.wallet),
            fetchPoolBins(pool.pool_id),
          ]);
          if (userBins.length === 0) continue;
          const activeBin = binsData.active_bin_id || pool.active_bin;
          positions.push(assessPosition(pool, userBins, activeBin, binsData.bins));
        } catch {
          log(`Skipping ${pool.pool_id}: no position or API error`);
        }
      }

      const needsMove = positions.filter((p) => !p.in_range);
      out("success", "scan", {
        wallet: opts.wallet,
        pools_scanned: pools.length,
        positions_found: positions.length,
        out_of_range: needsMove.length,
        positions,
      });
    } catch (e: unknown) {
      out("error", "scan", null, (e as Error).message);
    }
  });

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Move liquidity back to active range (dry-run unless --confirm)")
  .requiredOption("--wallet <address>", "STX address")
  .requiredOption("--pool <id>", "Pool ID (e.g. dlmm_1)")
  .option("--confirm", "Execute on-chain (without this flag: preview only)")
  .option("--password <pass>", "Wallet password (required with --confirm)")
  .option("--spread <n>", "Bin spread ±N around active bin", String(BIN_SPREAD))
  .action(async (opts) => {
    try {
      const poolId: string = opts.pool;
      const wallet: string = opts.wallet;
      const spread = Math.min(Math.max(parseInt(opts.spread, 10) || BIN_SPREAD, 1), 10);
      const confirmed: boolean = opts.confirm === true;

      // 1. Fetch pool + position data
      const pools = await fetchPools();
      const pool = pools.find((p) => p.pool_id === poolId);
      if (!pool) {
        out("error", "run", null, `Pool ${poolId} not found`);
        return;
      }

      const [userBins, binsData, stxBal] = await Promise.all([
        fetchUserPositions(poolId, wallet),
        fetchPoolBins(poolId),
        fetchStxBalance(wallet),
      ]);

      if (userBins.length === 0) {
        out("blocked", "run", { pool_id: poolId }, "No position found in this pool");
        return;
      }

      const activeBin = binsData.active_bin_id || pool.active_bin;
      const health = assessPosition(pool, userBins, activeBin, binsData.bins);

      // 2. Gate: already in range
      if (health.in_range) {
        out("success", "run", {
          decision: "IN_RANGE",
          reason: "Position is already in the active range — earning fees. No move needed.",
          health,
        });
        return;
      }

      // 3. Gate: non-zero position
      if (BigInt(health.total_dlp) === 0n) {
        out("blocked", "run", { health }, "Position has zero liquidity");
        return;
      }

      // 4. Gate: gas
      if (stxBal < 1) {
        out("blocked", "run", { stx_balance: stxBal }, "Insufficient STX for gas (need ≥1 STX for two transactions)");
        return;
      }

      // 5. Gate: cooldown
      const state = loadState();
      const cdMs = cooldownRemaining(state, poolId);
      if (cdMs > 0) {
        const cdMin = Math.ceil(cdMs / 60_000);
        out("blocked", "run", { cooldown_minutes: cdMin }, `Cooldown active — ${cdMin} minutes remaining`);
        return;
      }

      // 6. Build plans
      const withdrawPositions = buildWithdrawPositions(userBins, activeBin);
      const totalX = BigInt(health.total_x);
      const totalY = BigInt(health.total_y);
      // Use 98% of estimated amounts to account for rounding between withdraw and deposit
      const safeX = (totalX * 98n) / 100n;
      const safeY = (totalY * 98n) / 100n;
      const depositBins = buildDepositBins(safeX, safeY, spread);

      const plan = {
        pool_id: poolId,
        pair: health.pair,
        active_bin: activeBin,
        old_range: { min: health.user_bin_min, max: health.user_bin_max, bins: health.user_bins.length },
        new_range: { min: activeBin - spread, max: activeBin + spread, bins: depositBins.length },
        withdraw: {
          positions: withdrawPositions.length,
          estimated_x: health.total_x,
          estimated_y: health.total_y,
        },
        deposit: {
          bins: depositBins.length,
          x_per_bin_above: depositBins.find((b) => b.activeBinOffset > 0)?.xAmount ?? "0",
          y_per_bin_below: depositBins.find((b) => b.activeBinOffset < 0)?.yAmount ?? "0",
        },
        stx_balance: stxBal,
        estimated_gas_stx: 0.1,
      };

      // 7. Dry run
      if (!confirmed) {
        out("success", "run", {
          decision: "MOVE_NEEDED",
          mode: "dry-run",
          reason: `Position drifted ${health.drift} bins from active. Add --confirm --password <pass> to execute.`,
          health,
          plan,
        });
        return;
      }

      // 8. Execute
      if (!opts.password) {
        out("blocked", "run", null, "--password required with --confirm");
        return;
      }

      log("Decrypting wallet...");
      const keys = await getWalletKeys(opts.password);
      if (keys.stxAddress !== wallet) {
        out("error", "run", null, `Wallet address mismatch: expected ${wallet}, got ${keys.stxAddress}`);
        return;
      }

      const nonce = await fetchNonce(wallet);
      log(`Nonce: ${nonce}`);

      // Step 1: Withdraw
      log("Broadcasting withdrawal...");
      const withdrawTxId = await executeWithdraw(keys.stxPrivateKey, pool, withdrawPositions, nonce);
      log(`Withdrawal broadcast: ${withdrawTxId}`);

      // Step 2: Deposit (nonce+1 — waits for withdrawal to confirm)
      log("Broadcasting deposit...");
      const depositTxId = await executeDeposit(keys.stxPrivateKey, pool, depositBins, activeBin, nonce + 1n);
      log(`Deposit broadcast: ${depositTxId}`);

      // 9. Record cooldown
      state[poolId] = { last_move_at: new Date().toISOString() };
      saveState(state);

      out("success", "run", {
        decision: "EXECUTED",
        health,
        plan,
        transactions: {
          withdraw: { txid: withdrawTxId, explorer: `${EXPLORER}/${withdrawTxId}?chain=mainnet` },
          deposit: { txid: depositTxId, explorer: `${EXPLORER}/${depositTxId}?chain=mainnet` },
        },
      });
    } catch (e: unknown) {
      out("error", "run", null, (e as Error).message);
    }
  });

// ── install-packs ─────────────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install dependency packs (none required)")
  .action(async () => {
    out("success", "install-packs", { installed: [], note: "No external packs required." });
  });

// ─── Entry ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  program.parse(process.argv);
}
