#!/usr/bin/env bun
/**
 * Roda o gabarito reference/verify-schema.ts com o DATABASE_URL do projeto
 * (padrão: Postgres do docker-compose na 55432), sem tocar em reference/.
 */
import { loadConfig } from "../src/infrastructure/config/app-config";

process.env.DATABASE_URL = loadConfig().databaseUrl;
// especificador não literal: o gabarito não entra no typecheck do projeto
const target = new URL("../reference/verify-schema.ts", import.meta.url).href;
await import(target);
