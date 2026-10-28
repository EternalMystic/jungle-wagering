/**
 * `assertGlobalInvariants(db)`: executa CADA consulta de `reference/sql/invariants.sql`
 * (I1–I8) contra o banco do teste. Cada consulta devolve as linhas que violam a regra;
 * todas precisam voltar vazias. O arquivo é lido em runtime — fonte única, sem cópia.
 */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { REPO_ROOT } from "./database";

export interface InvariantQuery {
  readonly label: string;
  readonly sql: string;
}

export function loadInvariantQueries(): InvariantQuery[] {
  const text = readFileSync(join(REPO_ROOT, "reference", "sql", "invariants.sql"), "utf8");
  const queries: InvariantQuery[] = [];
  for (const chunk of text.split(/;\s*\n/)) {
    const label = chunk.match(/--\s*(I\d+\.[^\n]*)/)?.[1]?.trim();
    const sql = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (!label || !/\bselect\b/i.test(sql)) continue;
    queries.push({ label, sql });
  }
  if (queries.length < 8) {
    throw new Error(`invariants.sql: esperadas ≥ 8 consultas (I1–I8), encontradas ${queries.length}`);
  }
  return queries;
}

export async function findInvariantViolations(db: Pool): Promise<Record<string, unknown[]>> {
  const violations: Record<string, unknown[]> = {};
  for (const q of loadInvariantQueries()) {
    const res = await db.query(q.sql);
    if (res.rows.length > 0) violations[q.label] = res.rows.slice(0, 5);
  }
  return violations;
}

export async function assertGlobalInvariants(db: Pool): Promise<void> {
  expect(await findInvariantViolations(db)).toEqual({});
}
