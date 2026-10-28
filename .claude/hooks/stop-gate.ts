#!/usr/bin/env bun
/**
 * Stop hook — antes de o Claude declarar a tarefa concluída, roda typecheck e testes
 * unitários. Se falharem, devolve o motivo e impede a parada (uma vez: respeita
 * stop_hook_active para não entrar em laço). Integração/concorrência são lentas
 * demais para cada parada; ficam para /checkpoint.
 */
const input = JSON.parse(await Bun.stdin.text()) as { stop_hook_active?: boolean; cwd?: string };
if (input.stop_hook_active) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const pkg = Bun.file(`${root}/package.json`);
if (!(await pkg.exists())) process.exit(0); // antes do spike não há o que checar

const scripts: Record<string, string> = (await pkg.json()).scripts ?? {};
const steps: [string, string[]][] = [];
if (scripts.typecheck) steps.push(["typecheck", ["bun", "run", "typecheck"]]);
steps.push(["unit", ["bun", "test", "test/unit"]]);

const failures: string[] = [];
for (const [name, cmd] of steps) {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
  if (p.exitCode !== 0) {
    const out = (p.stdout.toString() + p.stderr.toString()).split("\n").slice(-40).join("\n");
    // "nenhum teste encontrado" ainda não é falha
    if (name === "unit" && /no tests found|0 tests|did not match any test files/i.test(out)) continue;
    failures.push(`### ${name} falhou\n${out}`);
  }
}

if (failures.length > 0) {
  console.log(JSON.stringify({
    decision: "block",
    reason: "Não declare concluído: corrija o código de produção (não os testes).\n\n" + failures.join("\n\n"),
  }));
}
process.exit(0);
