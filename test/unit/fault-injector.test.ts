import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FAULT_POINTS, FaultPoint, NO_FAULTS } from "../../src/application/ports/fault-injector";
import { InvalidConfigError, loadConfig } from "../../src/infrastructure/config/app-config";
import {
  ProcessKillFaultInjector,
  createFaultInjector,
} from "../../src/infrastructure/faults/process-kill-fault-injector";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("FaultInjector (D20)", () => {
  test("os quatro checkpoints nomeados existem", () => {
    expect([...FAULT_POINTS].sort()).toEqual([
      "after-claim-before-publish",
      "after-commit-before-ack",
      "after-publish-before-mark",
      "before-commit",
    ]);
  });

  test.each(["production", "development", undefined, ""])("NODE_ENV=%p com FAULT_POINT → no-op", (nodeEnv) => {
    expect(createFaultInjector(nodeEnv, FaultPoint.BeforeCommit)).toBe(NO_FAULTS);
  });

  test("NODE_ENV=test sem FAULT_POINT → no-op; com FAULT_POINT → arma o ponto", () => {
    expect(createFaultInjector("test", undefined)).toBe(NO_FAULTS);
    expect(createFaultInjector("test", FaultPoint.AfterCommitBeforeAck)).toBeInstanceOf(ProcessKillFaultInjector);
  });

  test("ponto não armado não faz nada", () => {
    const faults = new ProcessKillFaultInjector(FaultPoint.AfterPublishBeforeMark);
    for (const point of FAULT_POINTS.filter((p) => p !== FaultPoint.AfterPublishBeforeMark)) {
      expect(() => faults.checkpoint(point)).not.toThrow();
    }
  });

  test("config: FAULT_POINT desconhecido é erro (typo em teste não pode virar no-op silencioso)", () => {
    expect(() => loadConfig({ FAULT_POINT: "after-comit" })).toThrow(InvalidConfigError);
    expect(loadConfig({ FAULT_POINT: "before-commit", NODE_ENV: "test" })).toMatchObject({
      faultPoint: "before-commit",
      nodeEnv: "test",
    });
    expect(loadConfig({}).faultPoint).toBeUndefined();
  });

  test("ponto armado mata o PRÓPRIO processo na hora: nada depois do checkpoint roda", async () => {
    const script = [
      `import { ProcessKillFaultInjector } from "./src/infrastructure/faults/process-kill-fault-injector";`,
      `const f = new ProcessKillFaultInjector("before-commit");`,
      `f.checkpoint("after-commit-before-ack");`,
      `console.log("passou-pelo-ponto-nao-armado");`,
      `try { f.checkpoint("before-commit"); } finally { console.log("finally-rodou"); }`,
      `console.log("sobreviveu");`,
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

    expect(out).toContain("passou-pelo-ponto-nao-armado");
    expect(out).not.toContain("finally-rodou");
    expect(out).not.toContain("sobreviveu");
    expect(code).not.toBe(0);
    // POSIX reporta o sinal; no Windows o Bun traduz SIGKILL para TerminateProcess (sem sinal)
    if (process.platform !== "win32") expect(proc.signalCode).toBe("SIGKILL");
  });
});
