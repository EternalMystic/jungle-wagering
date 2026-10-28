/**
 * Banco isolado por arquivo de teste, no Postgres REAL do docker-compose.
 *
 * 1. Um banco-template é migrado UMA vez com o comando de produção
 *    (`bun run scripts/migrate.ts up`), num processo separado. O nome do template
 *    carrega o hash de `migrations/`: mudou uma migration → template novo.
 * 2. Cada arquivo de teste ganha `CREATE DATABASE … TEMPLATE <template>` (cópia
 *    física, ~ms) e o apaga no fim com `DROP DATABASE … WITH (FORCE)`.
 *
 * Corrida entre processos montando o mesmo template: cada um migra um banco
 * "em construção" de nome aleatório e tenta `RENAME` para o nome final; quem perde
 * (42P04) apaga o seu. Nenhum lock é necessário.
 */
import { Client, Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/infrastructure/config/app-config";
import { databaseUrlFor } from "./postgres";

export const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Pool do lado do teste: nunca menor que o paralelismo que os testes disparam. */
export const TEST_POOL_MAX = 64;

const DUPLICATE_DATABASE = "42P04";
const OBJECT_IN_USE = "55006";

function sqlState(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function adminUrl(): string {
  return databaseUrlFor(loadConfig().databaseUrl, "postgres");
}

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function migrationsFingerprint(): string {
  const dir = join(REPO_ROOT, "migrations");
  const hash = createHash("sha256");
  for (const file of readdirSync(dir).sort()) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

async function databaseExists(c: Client, name: string): Promise<boolean> {
  const res = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return (res.rowCount ?? 0) > 0;
}

/** Roda o MESMO comando de migração da produção, em outro processo. */
async function runMigrationsUp(databaseUrl: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, "run", "scripts/migrate.ts", "up"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`migration:up falhou (exit ${code}) em ${databaseUrl}\n${out}\n${err}`);
  }
}

let templateName: Promise<string> | undefined;

/** Template migrado (memoizado por processo de teste). */
export function migratedTemplate(): Promise<string> {
  templateName ??= buildTemplate();
  return templateName;
}

async function buildTemplate(): Promise<string> {
  const name = `wagering_tpl_${migrationsFingerprint()}`;
  if (await withAdmin((c) => databaseExists(c, name))) return name;

  const building = `wagering_tplb_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await withAdmin((c) => c.query(`CREATE DATABASE ${building}`));
  try {
    await runMigrationsUp(databaseUrlFor(loadConfig().databaseUrl, building));
    await withAdmin((c) => c.query(`ALTER DATABASE ${building} RENAME TO ${name}`));
  } catch (error) {
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`));
    if (sqlState(error) !== DUPLICATE_DATABASE) throw error;
  }
  return name;
}

export interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
  /** Pool de conexões distintas para asserções e para provocar disputa real. */
  readonly pool: Pool;
  drop(): Promise<void>;
}

/** `CREATE DATABASE <isolado> TEMPLATE <migrado>` + pool próprio. */
export async function createIsolatedDatabase(tag: string): Promise<IsolatedDatabase> {
  const template = await migratedTemplate();
  const safeTag = tag.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  const name = `wagering_acc_${safeTag}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

  // CREATE … TEMPLATE exige o template sem sessões; outro arquivo copiando ao mesmo
  // tempo é a única fonte de 55006, e a cópia leva milissegundos.
  for (let attempt = 1; ; attempt++) {
    try {
      await withAdmin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${template}`));
      break;
    } catch (error) {
      if (sqlState(error) !== OBJECT_IN_USE || attempt >= 20) throw error;
      await Bun.sleep(50 * attempt);
    }
  }

  const url = databaseUrlFor(loadConfig().databaseUrl, name);
  const pool = new Pool({ connectionString: url, max: TEST_POOL_MAX });
  return {
    name,
    url,
    pool,
    drop: async () => {
      await pool.end();
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
