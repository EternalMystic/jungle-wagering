/** Ids de entidades e eventos (UUID). Gerados na aplicação, nunca pelo banco. */
export interface IdGenerator {
  next(): string;
}
