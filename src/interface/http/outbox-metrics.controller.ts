import { Controller, Get, Header, Inject } from "@nestjs/common";

export const OUTBOX_METRICS = Symbol("OUTBOX_METRICS");
interface OutboxLag { lagSeconds(): Promise<number>; }

@Controller("metrics")
export class OutboxMetricsController {
  constructor(@Inject(OUTBOX_METRICS) private readonly metrics: OutboxLag) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metricsText(): Promise<string> {
    return `# HELP outbox_lag_seconds Age of the oldest unpublished event.\n# TYPE outbox_lag_seconds gauge\noutbox_lag_seconds ${await this.metrics.lagSeconds()}\n`;
  }
}
