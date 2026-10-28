#!/usr/bin/env bun
/**
 * Varre todos os arquivos versionados com as MESMAS regras do hook do Claude Code.
 * Roda no CI: cobre código escrito pelo Codex, pelo Copilot ou à mão, que não passa
 * pelos hooks. Saída ≠ 0 se houver violação.
 *
 *   bun run scripts/scan-forbidden.ts
 */
import { checkText } from "../.claude/hooks/rules.ts";

const files = Bun.spawnSync(["git", "ls-files", "src", "test"]).stdout.toString().split("\n").filter(Boolean);
const violations: string[] = [];

for (const path of files) {
  if (!/\.(ts|tsx|js|mjs|sql)$/.test(path)) continue;
  const text = await Bun.file(path).text();
  violations.push(...checkText(path, text));
}

if (violations.length > 0) {
  console.error(`✘ ${violations.length} violação(ões):\n- ${violations.join("\n- ")}`);
  process.exit(1);
}
console.log(`✔ ${files.length} arquivos varridos, nenhuma violação`);
