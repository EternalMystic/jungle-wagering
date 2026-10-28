/**
 * Regras de código proibido — fonte única usada por:
 *   - .claude/hooks/guard.ts      (bloqueia o Claude Code na hora da edição)
 *   - scripts/scan-forbidden.ts   (varre o repositório inteiro no CI: vale para
 *                                  código escrito por QUALQUER IA ou humano)
 */
export type Rule = { applies: (path: string) => boolean; re: RegExp; why: string };

const isSrc = (p: string) => p.startsWith("src/");
const isCore = (p: string) => /^src\/(domain|application)\//.test(p);
const isRealTest = (p: string) => /^test\/(integration|concurrency|acceptance)\//.test(p);
const isTest = (p: string) => p.startsWith("test/");

export const FROZEN_PATHS = [/^test\/acceptance\//, /^docs\/CHALLENGE\.md$/, /^reference\//];

export const RULES: Rule[] = [
  // dinheiro
  { applies: isSrc, re: /\bparseFloat\s*\(/, why: "parseFloat em código de produção: dinheiro é Money (bigint/string)." },
  { applies: isSrc, re: /\.toFixed\s*\(/, why: "toFixed() indica dinheiro em number. Use Money.toString()." },
  { applies: isCore, re: /\bNumber\s*\(|\bparseInt\s*\(|\bMath\.round\s*\(/, why: "Number()/parseInt/Math.round no domínio/aplicação: suspeito de dinheiro em float." },
  { applies: isSrc, re: /\b(amount|balance|money|valor|saldo)\w*\??\s*:\s*number\b/i, why: "campo monetário tipado como number (eliminatório)." },
  // pureza do domínio
  { applies: (p) => p.startsWith("src/domain/"), re: /from\s+['"](@nestjs|@mikro-orm|pg|@aws-sdk|pino|prom-client)/, why: "o domínio não pode importar framework/infra." },
  // idempotência em memória
  { applies: isSrc, re: /idempot[\s\S]{0,400}new\s+(Map|Set|LRUCache)\b|new\s+(Map|Set|LRUCache)\b[\s\S]{0,400}idempot/i, why: "estrutura em memória perto de idempotência: a garantia tem de ser o PostgreSQL." },
  // ledger imutável e lock global
  { applies: isSrc, re: /\b(UPDATE|DELETE\s+FROM)\s+"?wallet_ledger_entries/i, why: "UPDATE/DELETE no ledger (eliminatório)." },
  { applies: isSrc, re: /pg_advisory(_xact)?_lock\s*\(\s*\d+\s*\)/i, why: "advisory lock com chave constante = lock global (eliminatório)." },
  // testes honestos
  { applies: isTest, re: /\b(it|test|describe)\.(only|skip|todo)\s*\(/, why: "proibido .only/.skip/.todo." },
  { applies: isTest, re: /expect\s*\(\s*true\s*\)/, why: "expect(true) não prova nada." },
  { applies: isRealTest, re: /mock\.module\s*\(|jest\.mock\s*\(|vi\.mock\s*\(/, why: "mock em teste de integração/concorrência/aceitação: use PostgreSQL e SQS reais." },
];

export function checkText(path: string, text: string): string[] {
  return RULES.filter((r) => r.applies(path) && r.re.test(text)).map((r) => `${path}: ${r.why}`);
}
