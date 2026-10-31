import { Migration20261028000000_initial } from "./Migration20261028000000_initial";

// Registrar migrations novas aqui. Glob falha sob Bun e em binarios.
export const migrationsList = [
  { name: "Migration20261028000000_initial", class: Migration20261028000000_initial },
];
