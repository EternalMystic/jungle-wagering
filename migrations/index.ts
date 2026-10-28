import { Migration20261028000000_initial } from "./Migration20261028000000_initial";

/**
 * Lista explícita de migrations, em ordem. Não usamos descoberta por glob de arquivos
 * (frágil sob Bun e em binários); toda migration nova é registrada aqui.
 */
export const migrationsList = [
  { name: "Migration20261028000000_initial", class: Migration20261028000000_initial },
];
