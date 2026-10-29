import { type FaultInjector, type FaultPoint, NO_FAULTS } from "../../application/ports/fault-injector";

/**
 * Mata o PRÓPRIO processo com SIGKILL ao passar pelo ponto armado: sem `finally`, sem
 * shutdown hooks, sem ROLLBACK/COMMIT pendente enviado — o que um `kill -9` faria.
 */
export class ProcessKillFaultInjector implements FaultInjector {
  constructor(private readonly armed: FaultPoint) {}

  checkpoint(point: FaultPoint): void {
    if (point !== this.armed) return;
    process.kill(process.pid, "SIGKILL");
    // inalcançável; se o SO adiar o sinal, nada depois do ponto pode rodar
    throw new Error(`fault point ${point} reached but the process is still alive`);
  }
}

/** Só arma com `NODE_ENV=test`; em qualquer outro ambiente é no-op, mesmo com `FAULT_POINT`. */
export function createFaultInjector(nodeEnv: string | undefined, faultPoint: FaultPoint | undefined): FaultInjector {
  if (nodeEnv !== "test" || faultPoint === undefined) return NO_FAULTS;
  return new ProcessKillFaultInjector(faultPoint);
}
