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
  const tooSlow = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout após ${ms}ms`)), ms);
  });
  return Promise.race([promise, tooSlow]).finally(() => clearTimeout(timer));
}

@Controller("health")
export class HealthController {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: readonly ReadinessProbe[],
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  @Get("live")
  @HttpCode(200)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @HttpCode(200)
  async ready(): Promise<ReadinessReport> {
    const results = await Promise.allSettled(this.probes.map((p) => withTimeout(p.check(), this.timeoutMs)));
    const checks = {} as Record<string, ProbeStatus>;
    let ok = true;

    // Não sair na primeira falha: quero ver as outras dependências no 503 também.
    for (let idx = 0; idx < results.length; idx++) {
      const res = results[idx]!;
      const probe = this.probes[idx];
      if (probe) checks[probe.name] = res.status === "fulfilled" ? "up" : "down";
      if (res.status !== "fulfilled") ok = false;
    }
    if (!ok) {
      const report: ReadinessReport = { status: "unavailable", checks };
      throw new ServiceUnavailableException(report);
    }
    return { status: "ok", checks };
  }
}
