/**
 * Pontos nomeados onde um teste pode matar o processo (SIGKILL) para provar recuperação
 * após crash. Em produção a implementação é no-op (D20).
 */
export const FaultPoint = {
  /** Trabalho feito dentro da transação SQL, COMMIT ainda não enviado. */
  BeforeCommit: "before-commit",
  /** COMMIT confirmado; resposta HTTP / `DeleteMessage` do SQS ainda não enviados. */
  AfterCommitBeforeAck: "after-commit-before-ack",
  /** Outbox: lease tomado, evento ainda não enviado ao SQS. */
  AfterClaimBeforePublish: "after-claim-before-publish",
  /** Outbox: evento enviado ao SQS, `published_at` ainda não gravado. */
  AfterPublishBeforeMark: "after-publish-before-mark",
} as const;

export type FaultPoint = (typeof FaultPoint)[keyof typeof FaultPoint];

export const FAULT_POINTS: readonly FaultPoint[] = Object.values(FaultPoint);

export function isFaultPoint(value: string): value is FaultPoint {
  return (FAULT_POINTS as readonly string[]).includes(value);
}

export interface FaultInjector {
  /** Não retorna se `point` for o ponto armado: o processo morre ali, sem cleanup. */
  checkpoint(point: FaultPoint): void;
}

export const NO_FAULTS: FaultInjector = {
  checkpoint(): void {},
};
