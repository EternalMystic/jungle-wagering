import { Controller, Get, Header, Inject } from "@nestjs/common";
import { METRICS, PrometheusMetrics } from "../../infrastructure/metrics/prometheus-metrics";

export const OUTBOX_METRICS = Symbol("OUTBOX_METRICS");
interface OutboxLag { lagSeconds(): Promise<number>; }

@Controller("metrics")
export class OutboxMetricsController {
  constructor(@Inject(OUTBOX_METRICS) private readonly outbox: OutboxLag,
    @Inject(METRICS) private readonly metrics: Pick<PrometheusMetrics, "text"> = new PrometheusMetrics()) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metricsText(): Promise<string> {
    return this.metrics.text(await this.outbox.lagSeconds());
  }
}
