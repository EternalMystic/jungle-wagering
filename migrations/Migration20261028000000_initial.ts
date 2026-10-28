import { Migration } from "@mikro-orm/migrations";

/**
 * Migration inicial vazia (fase 01 — spike). Prova que o Migrator roda sob Bun e que
 * o round-trip up → down → up funciona. O schema real (reference/sql/001_schema.sql)
 * entra numa migration própria na fase 03.
 */
export class Migration20261028000000_initial extends Migration {
  override async up(): Promise<void> {
    // intencionalmente vazia
  }

  override async down(): Promise<void> {
    // intencionalmente vazia
  }
}
