#!/usr/bin/env bun
/**
 * Recusa, nos arquivos versionados de `src` e `test`, padrões que quebrariam uma garantia
 * do enunciado sem que um teste pegasse de imediato: dinheiro em `number`, idempotência em
 * memória, escrita no ledger, lock global, mocks nas suítes reais e testes desligados.
 * É grep com contexto, não análise semântica: complementa os testes, não os substitui.
 *
 *   bun run scripts/scan-forbidden.ts     # saída ≠ 0 se houver violação
 */
type Rule = { applies: (path: string) => boolean; pattern: RegExp; why: string };

const isSrc = (p: string) => p.startsWith("src/");
const isCore = (p: string) => /^src\/(domain|application)\//.test(p);
const isTest = (p: string) => p.startsWith("test/");
const isRealSuite = (p: string) => /^test\/(integration|concurrency|acceptance)\//.test(p);

const RULES: Rule[] = [
  { applies: isSrc, pattern: /\bparseFloat\s*\(/, why: "parseFloat em produção: dinheiro é Money (bigint em centavos)" },
  { applies: isSrc, pattern: /\.toFixed\s*\(/, why: "toFixed() indica dinheiro em number; use Money.toString()" },
  { applies: isCore, pattern: /\bNumber\s*\(|\bparseInt\s*\(|\bMath\.round\s*\(/, why: "conversão numérica no domínio/aplicação" },
  { applies: isSrc, pattern: /\b(amount|balance|money|valor|saldo)\w*\??\s*:\s*number\b/i, why: "campo monetário tipado como number" },
  { applies: (p) => p.startsWith("src/domain/"), pattern: /from\s+['"](@nestjs|@mikro-orm|pg|@aws-sdk|pino|prom-client)/, why: "o domínio não importa framework nem infraestrutura" },
  {
    applies: isSrc,
    pattern: /idempot[\s\S]{0,400}new\s+(Map|Set|LRUCache)\b|new\s+(Map|Set|LRUCache)\b[\s\S]{0,400}idempot/i,
    why: "estrutura em memória perto de idempotência; a garantia é o PostgreSQL",
  },
  { applies: isSrc, pattern: /\b(UPDATE|DELETE\s+FROM)\s+"?wallet_ledger_entries/i, why: "UPDATE/DELETE no ledger" },
  { applies: isSrc, pattern: /pg_advisory(_xact)?_lock\s*\(\s*\d+\s*\)/i, why: "advisory lock com chave constante é lock global" },
  { applies: isTest, pattern: /\b(it|test|describe)\.(only|skip|todo)\s*\(/, why: ".only/.skip/.todo deixam a suíte verde sem rodar casos" },
  { applies: isTest, pattern: /expect\s*\(\s*true\s*\)/, why: "expect(true) não verifica nada" },
  { applies: isRealSuite, pattern: /mock\.module\s*\(|jest\.mock\s*\(|vi\.mock\s*\(/, why: "mock nas suítes que usam PostgreSQL e SQS reais" },
];

const listing = Bun.spawnSync(["git", "ls-files", "src", "test"]);
if (listing.exitCode !== 0) {
  // sem a lista, "nenhuma violação" seria uma aprovação falsa
  console.error(`git ls-files falhou: ${listing.stderr.toString().trim()}`);
  process.exit(2);
}
const files = listing.stdout.toString().split("\n").filter((path) => /\.(ts|tsx|js|mjs|sql)$/.test(path));
const violations: string[] = [];

for (const path of files) {
  const text = await Bun.file(path).text();
  for (const rule of RULES) if (rule.applies(path) && rule.pattern.test(text)) violations.push(`${path}: ${rule.why}`);
}

if (violations.length > 0) {
  console.error(`✘ ${violations.length} violação(ões):\n- ${violations.join("\n- ")}`);
  process.exit(1);
}
console.log(`✔ ${files.length} arquivos varridos, nenhuma violação`);

export {};
