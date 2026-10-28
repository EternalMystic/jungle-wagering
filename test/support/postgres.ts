import { Client } from "pg";
import { randomUUID } from "node:crypto";

export function databaseUrlFor(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Banco descartável no MESMO servidor Postgres real; apagado em `drop()`. */
export async function createScratchDatabase(baseUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `wagering_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return {
    url: databaseUrlFor(baseUrl, name),
    drop: async () => {
      const c = new Client({ connectionString: baseUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export async function query<T extends Record<string, unknown>>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const res = await c.query<T>(sql, params);
    return res.rows;
  } finally {
    await c.end();
  }
}
