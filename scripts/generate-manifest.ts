#!/usr/bin/env bun
/**
 * generate-manifest.ts
 *
 * Scans all skills directories, extracts SKILL.md frontmatter, and writes
 * a skills.json manifest. This is the manifest format expected by
 * aibtcdev/skills (`bun run manifest`).
 *
 * Usage:
 *   bun run scripts/generate-manifest.ts              # write skills.json
 *   bun run scripts/generate-manifest.ts --dry-run    # print to stdout, don't write
 *
 * Output: skills.json in repo root
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

// ── Frontmatter Parser ─────────────────────────────────────────────────
// Same minimal parser as validate-frontmatter.ts

interface SkillEntry {
  name: string;
  description: string;
  metadata: Record<string, string>;
  directory: string;
  files: string[];
}

function parseFrontmatter(content: string): { fields: Record<string, string>; metadata: Record<string, string> } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const raw = match[1];
  const lines = raw.split("\n");
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;

  for (const line of lines) {
    if (line.match(/^metadata:\s*$/)) {
      inMetadata = true;
      continue;
    }

    if (inMetadata && line.match(/^\s{2,}\S/)) {
      const kv = line.match(/^\s+(\S+):\s*(.*)$/);
      if (kv) {
        let val = kv[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        metadata[kv[1].trim()] = val;
      }
      continue;
    }

    if (inMetadata && line.match(/^\S/)) {
      inMetadata = false;
    }

    const kv = line.match(/^(\S+):\s*(.*)$/);
    if (kv) {
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Handle YAML arrays: [a, b] → "a, b"
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).trim();
      }
      fields[kv[1].trim()] = val;
    }
  }

  return { fields, metadata };
}

// ── Scanner ────────────────────────────────────────────────────────────

function scanSkills(skillsDir: string): SkillEntry[] {
  if (!existsSync(skillsDir)) {
    console.error(`[manifest] Skills directory not found: ${skillsDir}`);
    return [];
  }

  const entries: SkillEntry[] = [];

  const dirs = readdirSync(skillsDir)
    .filter((d) => statSync(join(skillsDir, d)).isDirectory())
    .sort();

  for (const dir of dirs) {
    const skillPath = join(skillsDir, dir);
    const skillMdPath = join(skillPath, "SKILL.md");

    if (!existsSync(skillMdPath)) {
      console.error(`[manifest] Skipping ${dir} — no SKILL.md found`);
      continue;
    }

    const content = readFileSync(skillMdPath, "utf-8");
    const fm = parseFrontmatter(content);

    if (!fm) {
      console.error(`[manifest] Skipping ${dir} — no valid frontmatter`);
      continue;
    }

    // Build metadata from nested block or flat keys
    const meta: Record<string, string> = {};
    const metadataKeys = ["author", "author-agent", "user-invocable", "arguments", "entry", "requires", "tags"];

    for (const key of metadataKeys) {
      // Prefer nested metadata, fall back to flat
      const val = fm.metadata[key] || fm.fields[key] || fm.fields[key.replace("-", "_")];
      if (val) meta[key] = val;
    }

    // List files in the skill directory
    const files = readdirSync(skillPath);

    entries.push({
      name: fm.fields.name || dir,
      description: fm.fields.description || "",
      metadata: meta,
      directory: dir,
      files,
    });
  }

  return entries;
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skillsDir = args.find((a) => !a.startsWith("--")) || "skills";

  const skills = scanSkills(skillsDir);

  const manifest = {
    generated: new Date().toISOString(),
    source: "BitflowFinance/bff-skills",
    count: skills.length,
    skills,
  };

  const json = JSON.stringify(manifest, null, 2);

  if (dryRun) {
    console.log(json);
  } else {
    writeFileSync("skills.json", json + "\n", "utf-8");
    console.error(`[manifest] Generated skills.json with ${skills.length} skills`);
    console.log(
      JSON.stringify(
        {
          status: "success",
          action: `Generated skills.json with ${skills.length} skills`,
          data: {
            outputFile: "skills.json",
            skillCount: skills.length,
            skills: skills.map((s) => s.name),
          },
          error: null,
        },
        null,
        2
      )
    );
  }
}

main();
