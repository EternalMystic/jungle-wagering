/** Dependência externa cuja disponibilidade compõe o /health/ready. */
export interface ReadinessProbe {
  readonly name: string;
  /** Resolve se a dependência está alcançável; rejeita caso contrário. */
  check(): Promise<void>;
}
