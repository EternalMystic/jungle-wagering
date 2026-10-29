import type { Clock } from "../application/ports/clock";
import type { IdGenerator } from "../application/ports/id-generator";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenável por tempo (índices B-tree mais compactos que v4). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
