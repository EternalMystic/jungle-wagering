#!/usr/bin/env bun
// Roda o verificador de reference/ com o DATABASE_URL do projeto.
import { loadConfig } from "../src/infrastructure/config/app-config";

process.env.DATABASE_URL = loadConfig().databaseUrl;
// especificador não literal: o gabarito não entra no typecheck do projeto
const target = new URL("../reference/verify-schema.ts", import.meta.url).href;
await import(target);
