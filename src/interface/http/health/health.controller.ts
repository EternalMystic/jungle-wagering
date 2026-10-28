import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { ReadinessProbe } from "../../../application/ports/readiness-probe";
import { READINESS_PROBES, READINESS_TIMEOUT_MS } from "./tokens";

export type ProbeStatus = "up" | "down";

export interface ReadinessReport {
  readonly status: "ok" | "unavailable";
  readonly checks: Record<string, ProbeStatus>;
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout após ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Health checks sem autenticação (CHALLENGE §9). */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: readonly ReadinessProbe[],
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  /** Processo vivo: não toca em dependências externas. */
  @Get("live")
  @HttpCode(200)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** PostgreSQL (SELECT 1) e SQS (GetQueueUrl) alcançáveis; 503 se qualquer um falhar. */
  @Get("ready")
  @HttpCode(200)
  async ready(): Promise<ReadinessReport> {
    const results = await Promise.allSettled(this.probes.map((p) => withTimeout(p.check(), this.timeoutMs)));
    const checks: Record<string, ProbeStatus> = {};
    results.forEach((r, i) => {
      const probe = this.probes[i];
      if (probe) checks[probe.name] = r.status === "fulfilled" ? "up" : "down";
    });
    const allUp = results.every((r) => r.status === "fulfilled");
    if (!allUp) {
      const report: ReadinessReport = { status: "unavailable", checks };
      throw new ServiceUnavailableException(report);
    }
    return { status: "ok", checks };
  }
}
