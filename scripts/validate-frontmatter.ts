#!/usr/bin/env bun
/**
 * validate-frontmatter.ts
 *
 * Validates a skill submission against all rules documented in:
 *   - SKILL_TEMPLATE.md (frontmatter format, required sections)
 *   - README.md "Registry Compatibility" (nested metadata, string types)
 *   - PR template checklist (AGENT.md frontmatter, error format)
 *
 * Usage:
 *   bun run scripts/validate-frontmatter.ts                          # validate all skills
 *   bun run scripts/validate-frontmatter.ts skills/my-skill          # validate one skill
 *   bun run scripts/validate-frontmatter.ts --changed                # validate skills changed in current PR
 *
 * Output: JSON to stdout matching the competition output contract.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, basename, relative } from "path";
import { execFileSync } from "child_process";

// ── Types ──────────────────────────────────────────────────────────────

interface ValidationError {
  file: string;
  line: number | null;
  rule: string;
  severity: "error" | "warning";
  message: string;
  found: string;
  expected: string;
}

interface SkillValidation {
  skill: string;
  path: string;
  errors: ValidationError[];
  warnings: ValidationError[];
  passed: boolean;
}

// ── YAML Frontmatter Parser ────────────────────────────────────────────
// Minimal YAML parser for frontmatter — handles the subset needed for
// skill validation without importing a full YAML library.

interface ParsedFrontmatter {
  raw: string;
  fields: Record<string, string>;
  metadata: Record<string, string>;
  lines: string[];
  hasMetadataBlock: boolean;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const raw = match[1];
  const lines = raw.split("\n");
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;

  for (const line of lines) {
    // Detect metadata: block start
    if (line.match(/^metadata:\s*$/)) {
      inMetadata = true;
      continue;
    }

    // Indented line inside metadata block
    if (inMetadata && line.match(/^\s{2,}\S/)) {
      const kv = line.match(/^\s+(\S+):\s*(.*)$/);
      if (kv) {
        metadata[kv[1].trim()] = stripQuotes(kv[2].trim());
      }
      continue;
    }

    // Non-indented line exits metadata block
    if (inMetadata && line.match(/^\S/)) {
      inMetadata = false;
    }

    // Top-level field
    const kv = line.match(/^(\S+):\s*(.*)$/);
    if (kv) {
      fields[kv[1].trim()] = stripQuotes(kv[2].trim());
    }
  }

  return {
    raw,
    fields,
    metadata,
    lines,
    hasMetadataBlock: Object.keys(metadata).length > 0 || raw.includes("metadata:"),
  };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function findLineNumber(content: string, pattern: string | RegExp): number | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (typeof pattern === "string" ? lines[i].includes(pattern) : pattern.test(lines[i])) {
      return i + 1;
    }
  }
  return null;
}

function isYamlArray(rawContent: string, key: string): boolean {
  const line = rawContent.split("\n").find((l) => l.includes(`${key}:`) && l.includes("["));
  return !!line;
}

function isUnquotedBoolean(rawContent: string, key: string): boolean {
  const line = rawContent.split("\n").find((l) => {
    const m = l.match(new RegExp(`${key}:\\s*(true|false)\\s*$`));
    return m !== null;
  });
  return !!line;
}

// ── Validators ─────────────────────────────────────────────────────────

function validateSkillMd(skillPath: string, errors: ValidationError[]): void {
  const filePath = join(skillPath, "SKILL.md");
  const relFile = relative(process.cwd(), filePath);

  if (!existsSync(filePath)) {
    errors.push({
      file: relFile,
      line: null,
      rule: "file-exists",
      severity: "error",
      message: "SKILL.md is required but missing",
      found: "not found",
      expected: "skills/<name>/SKILL.md",
    });
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  const fm = parseFrontmatter(content);

  // ── Rule: frontmatter exists ──
  if (!fm) {
    errors.push({
      file: relFile,
      line: 1,
      rule: "frontmatter-exists",
      severity: "error",
      message: "No YAML frontmatter found. SKILL.md must start with --- delimited YAML.",
      found: content.slice(0, 40) + "...",
      expected: "---\\nname: ...\\n---",
    });
    return;
  }

  // ── Rule: name field ──
  if (!fm.fields.name) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "---"),
      rule: "name-required",
      severity: "error",
      message: "Top-level 'name' field is required in frontmatter",
      found: "missing",
      expected: "name: your-skill-name",
    });
  }

  // ── Rule: description field ──
  if (!fm.fields.description) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "---"),
      rule: "description-required",
      severity: "error",
      message: "Top-level 'description' field is required in frontmatter",
      found: "missing",
      expected: 'description: "One sentence about your skill"',
    });
  }

  // ── Rule: description should be quoted ──
  if (fm.fields.description) {
    const descLine = fm.raw.split("\n").find((l) => l.startsWith("description:"));
    if (descLine && !descLine.match(/description:\s*["']/)) {
      errors.push({
        file: relFile,
        line: findLineNumber(content, "description:"),
        rule: "description-quoted",
        severity: "warning",
        message: "description should be quoted to prevent YAML parsing issues",
        found: descLine.trim(),
        expected: `description: "${fm.fields.description}"`,
      });
    }
  }

  // ── Rule: metadata block exists (not flat keys) ──
  if (!fm.hasMetadataBlock) {
    // Check if they used flat keys instead
    const flatKeys = ["author", "tags", "requires", "entry", "user-invocable", "arguments"];
    const usedFlat = flatKeys.filter((k) => fm.fields[k]);
    if (usedFlat.length > 0) {
      errors.push({
        file: relFile,
        line: findLineNumber(content, usedFlat[0] + ":"),
        rule: "metadata-nested",
        severity: "error",
        message: `Frontmatter uses flat keys (${usedFlat.join(", ")}). Must use nested 'metadata:' block.`,
        found: `${usedFlat[0]}: ${fm.fields[usedFlat[0]]}`,
        expected: `metadata:\\n  ${usedFlat[0]}: "${fm.fields[usedFlat[0]]}"`,
      });
    } else {
      errors.push({
        file: relFile,
        line: findLineNumber(content, "---"),
        rule: "metadata-nested",
        severity: "error",
        message: "'metadata:' block is required in frontmatter",
        found: "missing",
        expected: "metadata:\\n  author: ...\\n  tags: ...",
      });
    }
  }

  // From here, validate metadata fields (check both nested and flat for helpful messages)
  const meta = fm.hasMetadataBlock ? fm.metadata : fm.fields;

  // ── Rule: metadata.author required ──
  if (!meta.author) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "metadata:"),
      rule: "author-required",
      severity: "error",
      message: "metadata.author is required. Use your GitHub username.",
      found: "missing",
      expected: '  author: "your-github-username"',
    });
  }

  // ── Rule: metadata.entry required ──
  if (!meta.entry) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "metadata:"),
      rule: "entry-required",
      severity: "error",
      message: "metadata.entry is required. Path to the .ts entrypoint.",
      found: "missing",
      expected: '  entry: "your-skill-name/your-skill-name.ts"',
    });
  }

  // ── Rule: entry path is repo-root-relative (no skills/ prefix) ──
  if (meta.entry && meta.entry.startsWith("skills/")) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "entry:"),
      rule: "entry-no-skills-prefix",
      severity: "error",
      message: "entry path must be repo-root-relative (no 'skills/' prefix). After promotion to aibtcdev/skills, skills live at root level.",
      found: meta.entry,
      expected: meta.entry.replace(/^skills\//, ""),
    });
  }

  // ── Rule: entry file exists ──
  if (meta.entry) {
    const entryAbs = join(skillPath, basename(meta.entry));
    const entryFromSkills = join(resolve(skillPath, ".."), meta.entry);
    if (!existsSync(entryAbs) && !existsSync(entryFromSkills)) {
      errors.push({
        file: relFile,
        line: findLineNumber(content, "entry:"),
        rule: "entry-file-exists",
        severity: "warning",
        message: `Entry file '${meta.entry}' not found relative to skill directory`,
        found: "not found",
        expected: `File at ${entryAbs} or ${entryFromSkills}`,
      });
    }
  }

  // ── Rule: tags is comma-separated string, not YAML array ──
  if (isYamlArray(fm.raw, "tags")) {
    const line = fm.raw.split("\n").find((l) => l.includes("tags:") && l.includes("["));
    errors.push({
      file: relFile,
      line: findLineNumber(content, "tags:"),
      rule: "tags-format",
      severity: "error",
      message: "tags must be a quoted comma-separated string, not a YAML array",
      found: line?.trim() || "tags: [...]",
      expected: '  tags: "defi, write, mainnet-only"',
    });
  }

  // ── Rule: requires is comma-separated string, not YAML array ──
  if (isYamlArray(fm.raw, "requires")) {
    const line = fm.raw.split("\n").find((l) => l.includes("requires:") && l.includes("["));
    errors.push({
      file: relFile,
      line: findLineNumber(content, "requires:"),
      rule: "requires-format",
      severity: "error",
      message: "requires must be a quoted comma-separated string, not a YAML array",
      found: line?.trim() || "requires: [...]",
      expected: '  requires: "wallet, signing, settings"',
    });
  }

  // ── Rule: user-invocable is string, not boolean ──
  if (isUnquotedBoolean(fm.raw, "user-invocable")) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "user-invocable:"),
      rule: "user-invocable-string",
      severity: "error",
      message: 'user-invocable must be a quoted string ("true" or "false"), not a bare boolean',
      found: `user-invocable: ${meta["user-invocable"]}`,
      expected: `user-invocable: "${meta["user-invocable"] || "false"}"`,
    });
  }

  // ── Rule: metadata.tags required ──
  if (!meta.tags) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "metadata:"),
      rule: "tags-required",
      severity: "warning",
      message: "metadata.tags is recommended. Helps agent discovery.",
      found: "missing",
      expected: '  tags: "defi, write, mainnet-only"',
    });
  }

  // ── Rule: metadata.arguments required ──
  if (!meta.arguments) {
    errors.push({
      file: relFile,
      line: findLineNumber(content, "metadata:"),
      rule: "arguments-required",
      severity: "warning",
      message: "metadata.arguments is recommended. Lists available commands.",
      found: "missing",
      expected: '  arguments: "doctor | run | status"',
    });
  }

  // ── Required body sections ──
  const requiredSections = [
    { heading: "What it does", rule: "section-what-it-does" },
    { heading: "Why agents need it", rule: "section-why-agents" },
    { heading: "Safety notes", rule: "section-safety" },
    { heading: "Commands", rule: "section-commands" },
    { heading: "Output contract", rule: "section-output-contract" },
  ];

  for (const { heading, rule } of requiredSections) {
    const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im");
    if (!pattern.test(content)) {
      errors.push({
        file: relFile,
        line: null,
        rule,
        severity: "error",
        message: `Required section '## ${heading}' not found in SKILL.md body`,
        found: "missing",
        expected: `## ${heading}`,
      });
    }
  }
}

function validateAgentMd(skillPath: string, errors: ValidationError[]): void {
  const filePath = join(skillPath, "AGENT.md");
  const relFile = relative(process.cwd(), filePath);

  if (!existsSync(filePath)) {
    errors.push({
      file: relFile,
      line: null,
      rule: "agent-file-exists",
      severity: "error",
      message: "AGENT.md is required but missing",
      found: "not found",
      expected: "skills/<name>/AGENT.md",
    });
    return;
  }

  const content = readFileSync(filePath, "utf-8");

  // ── Rule: AGENT.md starts with YAML frontmatter ──
  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push({
      file: relFile,
      line: 1,
      rule: "agent-frontmatter",
      severity: "error",
      message: "AGENT.md must start with YAML frontmatter containing name, skill, and description",
      found: content.slice(0, 60) + "...",
      expected: "---\\nname: your-skill-name-agent\\nskill: your-skill-name\\ndescription: ...\\n---",
    });
  } else {
    // ── Rule: required frontmatter fields ──
    for (const field of ["name", "skill", "description"]) {
      if (!fm.fields[field]) {
        errors.push({
          file: relFile,
          line: findLineNumber(content, "---"),
          rule: `agent-fm-${field}`,
          severity: "error",
          message: `AGENT.md frontmatter missing required field: '${field}'`,
          found: "missing",
          expected: `${field}: your-value`,
        });
      }
    }
  }

  // ── Required body sections ──
  const requiredSections = [
    { heading: "Decision order", rule: "agent-decision-order" },
    { heading: "Guardrails", rule: "agent-guardrails" },
  ];

  for (const { heading, rule } of requiredSections) {
    const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im");
    if (!pattern.test(content)) {
      errors.push({
        file: relFile,
        line: null,
        rule,
        severity: "warning",
        message: `Recommended section '## ${heading}' not found in AGENT.md`,
        found: "missing",
        expected: `## ${heading}`,
      });
    }
  }
}

function validateTsFile(skillPath: string, errors: ValidationError[]): void {
  const skillName = basename(skillPath);
  const expectedFile = `${skillName}.ts`;
  const filePath = join(skillPath, expectedFile);
  const relFile = relative(process.cwd(), filePath);

  // Find any .ts file in the directory
  const tsFiles = existsSync(skillPath)
    ? readdirSync(skillPath).filter((f) => f.endsWith(".ts"))
    : [];

  if (tsFiles.length === 0) {
    errors.push({
      file: relFile,
      line: null,
      rule: "ts-file-exists",
      severity: "error",
      message: "No .ts implementation file found in skill directory",
      found: "no .ts files",
      expected: expectedFile,
    });
    return;
  }

  // Check naming convention
  if (!tsFiles.includes(expectedFile)) {
    errors.push({
      file: relFile,
      line: null,
      rule: "ts-naming",
      severity: "warning",
      message: `Expected .ts file named '${expectedFile}' matching directory name. Found: ${tsFiles.join(", ")}`,
      found: tsFiles.join(", "),
      expected: expectedFile,
    });
  }

  // Validate the main .ts file (prefer matching name, fall back to first)
  const mainTs = tsFiles.includes(expectedFile) ? expectedFile : tsFiles[0];
  const mainTsPath = join(skillPath, mainTs);
  const mainTsRel = relative(process.cwd(), mainTsPath);
  const tsContent = readFileSync(mainTsPath, "utf-8");

  // ── Rule: shebang ──
  if (!tsContent.startsWith("#!/usr/bin/env bun")) {
    errors.push({
      file: mainTsRel,
      line: 1,
      rule: "ts-shebang",
      severity: "warning",
      message: "Recommended: start .ts file with #!/usr/bin/env bun shebang",
      found: tsContent.split("\n")[0].slice(0, 40),
      expected: "#!/usr/bin/env bun",
    });
  }

  // ── Rule: JSON output ──
  if (!tsContent.includes("JSON.stringify")) {
    errors.push({
      file: mainTsRel,
      line: null,
      rule: "ts-json-output",
      severity: "warning",
      message: "No JSON.stringify found — skill must output JSON to stdout",
      found: "no JSON.stringify call detected",
      expected: "console.log(JSON.stringify(...))",
    });
  }
}

function validateStructure(skillPath: string, errors: ValidationError[]): void {
  const relPath = relative(process.cwd(), skillPath);

  if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) {
    errors.push({
      file: relPath,
      line: null,
      rule: "dir-exists",
      severity: "error",
      message: "Skill directory not found",
      found: "not found",
      expected: "skills/<name>/ directory",
    });
    return;
  }

  const files = readdirSync(skillPath);
  const required = ["SKILL.md", "AGENT.md"];
  const hasTs = files.some((f) => f.endsWith(".ts"));

  for (const req of required) {
    if (!files.includes(req)) {
      errors.push({
        file: join(relPath, req),
        line: null,
        rule: "structure-required-file",
        severity: "error",
        message: `Required file '${req}' missing from skill directory`,
        found: `files: ${files.join(", ")}`,
        expected: req,
      });
    }
  }

  if (!hasTs) {
    errors.push({
      file: relPath,
      line: null,
      rule: "structure-ts-file",
      severity: "error",
      message: "No .ts implementation file found",
      found: `files: ${files.join(", ")}`,
      expected: "<skill-name>.ts",
    });
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────

function validateSkill(skillPath: string): SkillValidation {
  const absPath = resolve(skillPath);
  const skillName = basename(absPath);
  const allIssues: ValidationError[] = [];

  validateStructure(absPath, allIssues);
  validateSkillMd(absPath, allIssues);
  validateAgentMd(absPath, allIssues);
  validateTsFile(absPath, allIssues);

  const errors = allIssues.filter((e) => e.severity === "error");
  const warnings = allIssues.filter((e) => e.severity === "warning");

  return {
    skill: skillName,
    path: relative(process.cwd(), absPath),
    errors,
    warnings,
    passed: errors.length === 0,
  };
}

function discoverSkills(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((d) => statSync(join(skillsDir, d)).isDirectory())
    .map((d) => join(skillsDir, d))
    .sort();
}

// ── CLI ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let skillPaths: string[] = [];

  if (args.includes("--changed")) {
    // Detect which skill directories changed relative to main
    // Uses execFileSync (no shell) to avoid injection risk
    try {
      const diff = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf-8",
      });
      const changed = new Set(
        diff
          .split("\n")
          .filter((f) => f.startsWith("skills/"))
          .map((f) => f.split("/")[1])
      );
      skillPaths = Array.from(changed)
        .filter(Boolean)
        .map((d) => join("skills", d));
    } catch {
      console.error("[validate] Could not diff against origin/main — validating all skills");
      skillPaths = discoverSkills("skills");
    }
  } else if (args.length > 0 && !args[0].startsWith("--")) {
    // Validate specific skill(s)
    skillPaths = args;
  } else {
    // Validate all skills
    skillPaths = discoverSkills("skills");
  }

  if (skillPaths.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: "success",
          action: "No skills found to validate",
          data: { validated: 0 },
          error: null,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const results = skillPaths.map(validateSkill);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);
  const allPassed = results.every((r) => r.passed);

  // Pretty-print to stderr for human readability
  for (const result of results) {
    const icon = result.passed ? "✅" : "❌";
    console.error(`\n${icon} ${result.skill} (${result.path})`);

    for (const err of result.errors) {
      const loc = err.line ? `:${err.line}` : "";
      console.error(`  ❌ [${err.rule}] ${err.file}${loc}`);
      console.error(`     ${err.message}`);
      console.error(`     found:    ${err.found}`);
      console.error(`     expected: ${err.expected}`);
    }

    for (const warn of result.warnings) {
      const loc = warn.line ? `:${warn.line}` : "";
      console.error(`  ⚠️  [${warn.rule}] ${warn.file}${loc}`);
      console.error(`     ${warn.message}`);
    }
  }

  console.error(
    `\n${"─".repeat(60)}\n` +
      `Skills validated: ${results.length} | ` +
      `Errors: ${totalErrors} | ` +
      `Warnings: ${totalWarnings} | ` +
      `${allPassed ? "ALL PASSED ✅" : "FAILED ❌"}\n`
  );

  // JSON output to stdout for CI and agent consumption
  console.log(
    JSON.stringify(
      {
        status: allPassed ? "success" : "error",
        action: allPassed
          ? `All ${results.length} skills passed validation`
          : `Fix ${totalErrors} errors before opening PR`,
        data: {
          validated: results.length,
          passed: results.filter((r) => r.passed).length,
          failed: results.filter((r) => !r.passed).length,
          totalErrors,
          totalWarnings,
          results: results.map((r) => ({
            skill: r.skill,
            passed: r.passed,
            errorCount: r.errors.length,
            warningCount: r.warnings.length,
            errors: r.errors,
            warnings: r.warnings,
          })),
        },
        error: allPassed
          ? null
          : {
              code: "VALIDATION_FAILED",
              message: `${totalErrors} errors found across ${results.filter((r) => !r.passed).length} skills`,
              next: "Fix the errors listed below and re-run validation",
              details: results
                .flatMap((r) =>
                  r.errors.map((e) => ({
                    skill: r.skill,
                    rule: e.rule,
                    file: e.file,
                    line: e.line,
                    message: e.message,
                    found: e.found,
                    expected: e.expected,
                  }))
                ),
            },
      },
      null,
      2
    )
  );

  process.exit(allPassed ? 0 : 1);
}

main();
