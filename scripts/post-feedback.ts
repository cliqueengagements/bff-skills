#!/usr/bin/env bun
/**
 * post-feedback.ts
 *
 * Posts approved feedback comments to GitHub PRs via the REST API.
 *
 * Two modes:
 *   1. Batch:  --file feedback.json --pr-map "skill1=42,skill2=45"
 *   2. Single: --pr 45 --message "Your feedback here"
 *
 * Options:
 *   --dry-run   Print what would be posted without calling the API
 *
 * Auth: Requires GITHUB_TOKEN env var.
 *
 * Output: JSON to stdout with { status, action, data: { posted, skipped, total } }
 */

import { readFileSync } from "fs";

// ── Constants ─────────────────────────────────────────────────────────

const REPO = "BitflowFinance/bff-skills";
const API_BASE = `https://api.github.com/repos/${REPO}/issues`;

// ── Types ─────────────────────────────────────────────────────────────

interface FeedbackItem {
  skill: string;
  score: number;
  message: string;
}

interface PostResult {
  skill: string;
  pr: number;
  status: "posted" | "skipped" | "error";
  detail?: string;
}

// ── Arg Parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const parsed: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--file" && args[i + 1]) {
      parsed.file = args[++i];
    } else if (arg === "--pr-map" && args[i + 1]) {
      parsed.prMap = args[++i];
    } else if (arg === "--pr" && args[i + 1]) {
      parsed.pr = args[++i];
    } else if (arg === "--message" && args[i + 1]) {
      parsed.message = args[++i];
    }
  }

  return parsed;
}

// ── PR Map Parser ─────────────────────────────────────────────────────

function parsePrMap(raw: string): Map<string, number> {
  const map = new Map<string, number>();
  const pairs = raw.split(",").map((s) => s.trim()).filter(Boolean);

  for (const pair of pairs) {
    const [skill, prStr] = pair.split("=");
    if (!skill || !prStr) {
      console.error(`[post-feedback] Invalid pr-map pair: "${pair}" — expected skill=PR_NUMBER`);
      continue;
    }
    const prNum = parseInt(prStr, 10);
    if (isNaN(prNum)) {
      console.error(`[post-feedback] Invalid PR number in pair: "${pair}"`);
      continue;
    }
    map.set(skill.trim(), prNum);
  }

  return map;
}

// ── Feedback File Loader ──────────────────────────────────────────────

function loadFeedbackItems(filePath: string): FeedbackItem[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  // Accept full format-judging-output.ts output (has .feedbackDrafts)
  if (parsed.feedbackDrafts && Array.isArray(parsed.feedbackDrafts)) {
    return parsed.feedbackDrafts;
  }

  // Accept raw array of {skill, score, message}
  if (Array.isArray(parsed)) {
    return parsed;
  }

  throw new Error(
    `Unrecognized feedback file format. Expected { feedbackDrafts: [...] } or a raw array of { skill, score, message }.`
  );
}

// ── GitHub API ────────────────────────────────────────────────────────

async function postComment(pr: number, body: string, token: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const url = `${API_BASE}/${pr}/comments`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const resetEpoch = res.headers.get("x-ratelimit-reset");
      const resetDate = resetEpoch ? new Date(parseInt(resetEpoch, 10) * 1000).toISOString() : "unknown";
      return { ok: false, status: 403, detail: `Rate limited. Resets at ${resetDate}` };
    }
    return { ok: false, status: 403, detail: `Forbidden: ${await res.text()}` };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, detail: await res.text() };
  }

  return { ok: true, status: res.status, detail: "Comment posted" };
}

// ── Delay Utility ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Single Mode ───────────────────────────────────────────────────────

async function runSingle(pr: number, message: string, dryRun: boolean, token: string): Promise<void> {
  if (dryRun) {
    console.error(`[dry-run] Would post to PR #${pr}:`);
    console.error(message);
    console.log(
      JSON.stringify(
        {
          status: "success",
          action: "dry-run",
          data: { posted: 1, skipped: 0, total: 1 },
        },
        null,
        2
      )
    );
    return;
  }

  const result = await postComment(pr, message, token);

  if (result.ok) {
    console.error(`[post-feedback] Posted comment to PR #${pr}`);
    console.log(
      JSON.stringify(
        {
          status: "success",
          action: `Posted feedback to PR #${pr}`,
          data: { posted: 1, skipped: 0, total: 1 },
        },
        null,
        2
      )
    );
  } else {
    console.error(`[post-feedback] Failed to post to PR #${pr}: ${result.detail}`);
    console.log(
      JSON.stringify(
        {
          status: "error",
          action: `Failed to post to PR #${pr}`,
          data: { posted: 0, skipped: 0, total: 1 },
          error: { code: `HTTP_${result.status}`, message: result.detail },
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

// ── Batch Mode ────────────────────────────────────────────────────────

async function runBatch(
  filePath: string,
  prMapRaw: string | undefined,
  dryRun: boolean,
  token: string
): Promise<void> {
  const items = loadFeedbackItems(filePath);

  if (items.length === 0) {
    console.error("[post-feedback] No feedback items found in file");
    console.log(
      JSON.stringify(
        { status: "success", action: "No feedback to post", data: { posted: 0, skipped: 0, total: 0 } },
        null,
        2
      )
    );
    return;
  }

  // Require PR map
  if (!prMapRaw) {
    const skillNames = items.map((i) => i.skill);
    console.error(`[post-feedback] --pr-map is required in batch mode.`);
    console.error(`[post-feedback] Skills found in file: ${skillNames.join(", ")}`);
    console.error(`[post-feedback] Example: --pr-map "${skillNames.map((s) => `${s}=PR_NUMBER`).join(",")}"`);
    console.log(
      JSON.stringify(
        {
          status: "error",
          action: "Missing --pr-map",
          data: { posted: 0, skipped: 0, total: items.length },
          error: {
            code: "MISSING_PR_MAP",
            message: `Provide --pr-map for: ${skillNames.join(", ")}`,
            availableSkills: skillNames,
          },
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const prMap = parsePrMap(prMapRaw);
  const results: PostResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const pr = prMap.get(item.skill);

    if (!pr) {
      console.error(`[post-feedback] Skipping "${item.skill}" — no PR number in --pr-map`);
      results.push({ skill: item.skill, pr: 0, status: "skipped", detail: "No PR mapping" });
      continue;
    }

    if (dryRun) {
      console.error(`[dry-run] Would post to PR #${pr}:`);
      console.error(item.message);
      console.error("");
      results.push({ skill: item.skill, pr, status: "posted", detail: "dry-run" });
    } else {
      const res = await postComment(pr, item.message, token);
      if (res.ok) {
        console.error(`[post-feedback] Posted feedback for "${item.skill}" to PR #${pr}`);
        results.push({ skill: item.skill, pr, status: "posted" });
      } else {
        console.error(`[post-feedback] Failed for "${item.skill}" on PR #${pr}: ${res.detail}`);
        results.push({ skill: item.skill, pr, status: "error", detail: res.detail });
      }

      // Rate limit: 1-second delay between posts in batch mode
      if (i < items.length - 1) {
        await delay(1000);
      }
    }
  }

  const posted = results.filter((r) => r.status === "posted").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errored = results.filter((r) => r.status === "error").length;
  const allOk = errored === 0;

  console.log(
    JSON.stringify(
      {
        status: allOk ? "success" : "error",
        action: allOk
          ? `Posted ${posted} feedback comments`
          : `Posted ${posted}, ${errored} failed`,
        data: {
          posted,
          skipped,
          total: items.length,
          results,
        },
      },
      null,
      2
    )
  );

  if (!allOk) process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = args.dryRun === true;
  const token = process.env.GITHUB_TOKEN || "";

  // Validate auth (unless dry-run)
  if (!dryRun && !token) {
    console.error("[post-feedback] GITHUB_TOKEN env var is required");
    console.log(
      JSON.stringify(
        {
          status: "error",
          action: "Missing GITHUB_TOKEN",
          data: { posted: 0, skipped: 0, total: 0 },
          error: { code: "NO_TOKEN", message: "Set GITHUB_TOKEN env var" },
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  // Single mode
  if (args.pr && args.message) {
    const prNum = parseInt(args.pr as string, 10);
    if (isNaN(prNum)) {
      console.error(`[post-feedback] Invalid --pr value: "${args.pr}"`);
      process.exit(1);
    }
    await runSingle(prNum, args.message as string, dryRun, token);
    return;
  }

  // Batch mode
  if (args.file) {
    await runBatch(args.file as string, args.prMap as string | undefined, dryRun, token);
    return;
  }

  // No valid mode
  console.error("Usage:");
  console.error('  bun run scripts/post-feedback.ts --file feedback.json --pr-map "skill1=42,skill2=45" [--dry-run]');
  console.error('  bun run scripts/post-feedback.ts --pr 45 --message "Your feedback here" [--dry-run]');
  process.exit(1);
}

main();
