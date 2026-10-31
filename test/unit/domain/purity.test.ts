import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const DOMAIN_DIR = join(import.meta.dir, "../../../src/domain");
const ALLOWED = [/^\.\.?\//, /^node:crypto$/];

const files = [...new Glob("**/*.ts").scanSync({ cwd: DOMAIN_DIR })];

describe("pureza do domínio (hexagonal: dependências apontam para dentro)", () => {
  test("o domínio tem os módulos do modelo da §6", () => {
    for (const expected of [
      "money.ts",
      "wallet.ts",
      "wager-transaction.ts",
      "ledger-entry.ts",
      "inbox-message.ts",
      "outbox-message.ts",
      "failure-codes.ts",
      "errors.ts",
      "payload-hash.ts",
      "events/integration-event.ts",
    ]) {
      expect(files.map((f) => f.replaceAll("\\", "/"))).toContain(expected);
    }
  });

  test.each(files)("%s importa só módulos do próprio domínio (ou node:crypto)", (file) => {
    const source = readFileSync(join(DOMAIN_DIR, file), "utf8");
    const specifiers = [...source.matchAll(/(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g)].map(
      (m) => m[1] ?? m[2] ?? "",
    );
    const foreign = specifiers.filter((s) => !ALLOWED.some((re) => re.test(s)));
    expect(foreign).toEqual([]);
    expect(source).not.toMatch(/@(Entity|Property|Injectable|PrimaryKey)\s*\(/);
  });
});
