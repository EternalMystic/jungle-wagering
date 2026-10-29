#!/usr/bin/env bun
/**
 * AUTOPILOT — conduz as fases do projeto sem supervisão, alternando Claude Code e Codex.
 *
 *   bun run scripts/autopilot.ts                  # continua da próxima fase pendente
 *   bun run scripts/autopilot.ts --unattended     # modo "fui embora": não para para revisão
 *   bun run scripts/autopilot.ts --approve 02     # registra sua revisão da fase 02 e continua
 *   bun run scripts/autopilot.ts --only 04        # roda só a fase 04
 *   bun run scripts/autopilot.ts --start codex    # Codex principal, Claude reserva
 *   bun run scripts/autopilot.ts --status         # mostra o estado e sai
 *
 * Quem decide que uma fase acabou é o PORTÃO (testes reais rodados pelo orquestrador),
 * nunca o que o agente diz. Passou → commit. Não passou → nova tentativa com o erro.
 *
 * Cota esgotada: o agente entra em espera (até o horário de reset, se a mensagem trouxer;
 * senão AUTOPILOT_COOLDOWN_MIN) e o outro assume a MESMA fase. Os dois sem cota → dorme
 * e tenta de novo sozinho. Uma execução que sai com erro em < 3 min sem mudar nada também
 * é tratada como falta de cota/infra (não gasta tentativa).
 *
 * --unattended:
 *   - a fase 02 (testes de aceitação) é revisada pelo OUTRO agente (fase 02r) em vez de
 *     esperar por você; REVISAR.md fica pronto para quando você voltar;
 *   - tentativas por fase sobem para 6 e os agentes se alternam após cada falha.
 *
 * Códigos de saída: 0 tudo pronto · 1 fase bloqueada · 3 aguardando sua revisão.
 *
 * Variáveis de ambiente:
 *   AUTOPILOT_YOLO=1            agentes sem perguntas de permissão (SÓ em VM/container)
 *   AUTOPILOT_COOLDOWN_MIN      espera quando o reset não é informado (padrão 30)
 *   AUTOPILOT_TIMEOUT_MIN       tempo máximo de uma execução de agente (padrão 120)
 *   AUTOPILOT_MAX_ATTEMPTS      tentativas por fase (padrão 3; 6 em --unattended)
 *   AUTOPILOT_REVIEW_WAIT_MIN   quanto esperar o outro agente para a revisão cruzada (padrão 90)
 *   AUTOPILOT_AGENTS=claude     agentes habilitados (padrão "claude,codex")
 *   AUTOPILOT_PUSH=1            git push para o ramo "autopilot" após cada fase
 *   AUTOPILOT_NTFY=<tópico>     notificação no celular via ntfy.sh
 *   AUTOPILOT_CLAUDE_CMD / AUTOPILOT_CODEX_CMD   (testes) prefixo do comando em JSON
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

// ------------------------------------------------------------------ fases
type Gate = { cmd: string; expect?: "pass" | "fail" };
type Phase = {
  id: string; file: string; gates: Gate[];
  humanReview?: boolean; mayEditFrozen?: boolean; unattendedOnly?: boolean; reviewerOf?: string;
};

const ALWAYS: Gate[] = [{ cmd: "bun run scripts/scan-forbidden.ts" }, { cmd: "bun run typecheck" }];
const UP: Gate = { cmd: "docker compose up -d --wait" };
const UNIT: Gate = { cmd: "bun run test:unit" };
const SCHEMA: Gate = { cmd: "bun run verify:schema" };
const MIGR: Gate = { cmd: "bun run migration:up && bun run migration:down && bun run migration:up" };
const ACC: Gate = { cmd: "bun run test:acceptance" };
const INTEG: Gate = { cmd: "bun run test:integration" };
const CONC3: Gate = { cmd: "for i in 1 2 3; do bun run test:concurrency || exit 1; done" };
const ACC_EXISTS: Gate = { cmd: "test -n \"$(git ls-files --others --cached test/acceptance | head -1)\"" };
const ACC_RED: Gate = { cmd: "bun run test:acceptance", expect: "fail" }; // a régua reprova o vazio

const PHASES: Phase[] = [
  { id: "01", file: "01-spike.md", gates: [UP, ...ALWAYS, { cmd: "bun run sqs:setup" }, MIGR, INTEG] },
  { id: "02", file: "02-acceptance.md", mayEditFrozen: true, humanReview: true, gates: [UP, ...ALWAYS, ACC_EXISTS, ACC_RED] },
  { id: "02r", file: "02r-revisao-cruzada.md", mayEditFrozen: true, unattendedOnly: true, reviewerOf: "02",
    gates: [UP, ...ALWAYS, ACC_EXISTS, ACC_RED, { cmd: "test -s docs/REVISAO-ACEITACAO.md" }] },
  { id: "03", file: "03-schema-dominio.md", gates: [UP, ...ALWAYS, UNIT, MIGR, SCHEMA] },
  { id: "04", file: "04-casos-de-uso-http.md", gates: [UP, ...ALWAYS, UNIT, MIGR, SCHEMA, ACC] },
  { id: "05", file: "05-harness-falhas.md", gates: [UP, ...ALWAYS, UNIT, ACC] },
  { id: "06", file: "06-consumer-sqs.md", gates: [UP, ...ALWAYS, UNIT, ACC, INTEG] },
  { id: "07", file: "07-outbox-pendencias.md", gates: [UP, ...ALWAYS, UNIT, ACC, INTEG, CONC3] },
  { id: "08", file: "08-auditoria.md", gates: [UP, ...ALWAYS, UNIT, SCHEMA, ACC, INTEG, CONC3, { cmd: "test -s docs/AUDITORIA.md" }] },
  { id: "09", file: "09-observabilidade.md", gates: [UP, ...ALWAYS, UNIT, ACC, INTEG, CONC3] },
  { id: "10", file: "10-documentacao.md", gates: [UP, ...ALWAYS, UNIT, ACC, INTEG, CONC3,
      { cmd: "test -s README.md && test -s ARCHITECTURE.md" }] },
];

const FROZEN = ["test/acceptance", "reference", "docs/CHALLENGE.md"];

// ------------------------------------------------------------------ argumentos
const args = process.argv.slice(2);
const argVal = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const unattended = args.includes("--unattended");
const yolo = process.env.AUTOPILOT_YOLO === "1";
const maxAttempts = Number(process.env.AUTOPILOT_MAX_ATTEMPTS ?? (unattended ? 6 : 3));
const cooldownMin = Number(process.env.AUTOPILOT_COOLDOWN_MIN ?? 30);

// ------------------------------------------------------------------ agentes
type AgentName = "claude" | "codex";
const other = (a: AgentName): AgentName => (a === "claude" ? "codex" : "claude");

function agentCommand(agent: AgentName, prompt: string): string[] {
  const override = process.env[agent === "claude" ? "AUTOPILOT_CLAUDE_CMD" : "AUTOPILOT_CODEX_CMD"];
  if (override) return [...JSON.parse(override), prompt];
  if (agent === "claude") {
    return ["claude", "-p", prompt, "--max-turns", "400", "--output-format", "text",
      ...(yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"])];
  }
  return ["codex", "exec",
    ...(yolo ? ["--dangerously-bypass-approvals-and-sandbox"]
             : ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]),
    prompt];
}

// mensagem explícita de limite do próprio agente (vale mesmo com código 0 e arquivos alterados)
const LIMIT_STRONG = /hit your [\w-]*\s*limit|usage limit reached|limit reached\|\d{10}|quota exceeded|rate limit reached|you've reached your .*limit/i;
const LIMIT_RE = /usage limit|rate[ _-]?limit|quota|limit reached|too many requests|\b429\b|overloaded|credits? (exhausted|depleted)|out of (credits|usage)|try again (at|in|later)|resets? (at|in)\b/i;

/** Tenta extrair da mensagem o instante de reset da cota. */
function parseReset(text: string): number | undefined {
  const epoch = text.match(/limit reached\|(\d{10})/i);
  if (epoch) return Number(epoch[1]) * 1000 + 60_000;
  const inMin = text.match(/(?:try again|resets?) in (\d+)\s*(min|minute|hour|h)\b/i);
  if (inMin) return Date.now() + Number(inMin[1]) * (/^h/i.test(inMin[2]!) ? 3_600_000 : 60_000) + 60_000;
  const at = text.match(/resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (at) {
    let h = Number(at[1]) % 12; if (/pm/i.test(at[3]!)) h += 12;
    const d = new Date(); d.setHours(h, Number(at[2] ?? 0), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime() + 60_000;
  }
  return undefined;
}

// ------------------------------------------------------------------ utilidades
const ROOT = process.cwd();
const DIR = `${ROOT}/autopilot`;
const STATE_FILE = `${DIR}/state.json`;
const LOGS = `${DIR}/logs`;
mkdirSync(LOGS, { recursive: true });

type State = {
  done: string[]; approved: string[]; by: Record<string, AgentName>;
  cooldownUntil: Partial<Record<AgentName, number>>;
};
const state: State = { done: [], approved: [], by: {}, cooldownUntil: {},
  ...(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}) };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const stamp = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
function log(msg: string) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  appendFileSync(`${DIR}/autopilot.log`, line + "\n");
}
async function notify(msg: string) {
  const topic = process.env.AUTOPILOT_NTFY;
  if (!topic) return;
  try { await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: msg }); } catch { /* sem rede: ignora */ }
}
const tail = (s: string, n = 80) => s.split("\n").slice(-n).join("\n");

async function sh(cmd: string, timeoutMs = 30 * 60_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bash", "-c", cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: out + err };
}

async function runAgent(agent: AgentName, prompt: string, logFile: string) {
  const cmd = agentCommand(agent, prompt);
  const started = Date.now();
  const before = (await sh("git status --porcelain && git rev-parse HEAD")).out;
  // via bash: no Windows (Git Bash) resolve os atalhos do npm (codex) e o claude.exe
  const p = Bun.spawn(["bash", "-c", 'exec "$0" "$@"', ...cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
  const timeoutMs = Number(process.env.AUTOPILOT_TIMEOUT_MIN ?? 120) * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGTERM"); }, timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  const all = out + "\n" + err;
  writeFileSync(logFile, all);
  const changed = (await sh("git status --porcelain && git rev-parse HEAD")).out !== before;
  const quickFail = code !== 0 && !changed && Date.now() - started < 3 * 60_000;
  const end = tail(all, 40);
  const limited = LIMIT_STRONG.test(tail(all, 12)) || (LIMIT_RE.test(end) && (code !== 0 || !changed));
  // saiu com erro na hora, sem mexer em nada e sem falar de cota = agente quebrado (flag, login, modelo…)
  const broken = !limited && quickFail;
  return { code, timedOut, limited, broken, output: all };
}

const ENABLED = (process.env.AUTOPILOT_AGENTS ?? "claude,codex").split(",").map((x) => x.trim()) as AgentName[];
const brokenStrikes: Partial<Record<AgentName, number>> = {};
function available(a: AgentName) { return ENABLED.includes(a) && (state.cooldownUntil[a] ?? 0) <= Date.now(); }

async function waitForAgent(preferred: AgentName): Promise<AgentName> {
  for (;;) {
    if (available(preferred)) return preferred;
    if (available(other(preferred))) return other(preferred);
    const until = Math.min(...ENABLED.map((a) => state.cooldownUntil[a] ?? Date.now()));
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
    log(`💤 os dois agentes estão sem cota; dormindo ${mins} min (até ${new Date(until).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })})`);
    await notify(`💤 Autopilot: sem cota nos dois agentes; retomo em ~${mins} min`);
    await Bun.sleep(Math.max(until - Date.now(), 1_000));
  }
}

async function revertFrozen(): Promise<string[]> {
  const { out } = await sh(`git status --porcelain -- ${FROZEN.join(" ")}`);
  const touched = out.split("\n").filter(Boolean).map((l) => l.slice(3));
  if (touched.length) await sh(`git checkout HEAD -- ${FROZEN.join(" ")} 2>/dev/null; git clean -fdq -- ${FROZEN.join(" ")}`);
  return touched;
}

async function runGates(phase: Phase): Promise<{ ok: boolean; report: string }> {
  let report = "";
  for (const g of phase.gates) {
    const { code, out } = await sh(g.cmd);
    const expect = g.expect ?? "pass";
    const ok = expect === "pass" ? code === 0 : code !== 0;
    report += `\n$ ${g.cmd}  → exit ${code} (esperado: ${expect === "pass" ? "0" : "≠0"}) ${ok ? "OK" : "FALHOU"}\n`;
    if (!ok) return { ok: false, report: report + tail(out) };
  }
  return { ok: true, report };
}

async function commit(phase: Phase, agent: AgentName) {
  await sh(`git add -A && git commit -qm "autopilot: fase ${phase.id} (${agent})" -m "Portão verde: ${phase.gates.map((x) => x.cmd).join(" | ").replace(/"/g, "'")}"`);
  if (process.env.AUTOPILOT_PUSH === "1") {
    const r = await sh("git remote get-url origin >/dev/null 2>&1 && git push -q origin HEAD:refs/heads/autopilot");
    if (r.code !== 0) log(`⚠️  push falhou (seguindo assim mesmo): ${tail(r.out, 3)}`);
  }
}

function writeReviewFile() {
  writeFileSync(`${DIR}/REVISAR.md`,
    `# Revisão humana: testes de aceitação (fase 02)\n\n` +
    (unattended
      ? `Rodou em modo --unattended: a régua foi escrita por ${state.by["02"] ?? "?"} e revisada por ` +
        `${state.by["02r"] ?? "?"} (ver docs/REVISAO-ACEITACAO.md), mas NÃO por você.\n\n`
      : "") +
    `Leia test/acceptance/ e test/support/ linha a linha. Confira que cada teste verifica o BANCO,\n` +
    `que o paralelismo é real e que nada é mockado. Se mudar algo nos testes, rode de novo as fases\n` +
    `seguintes (bun run scripts/autopilot.ts --only 04, etc.). Para registrar a aprovação:\n\n` +
    `    bun run scripts/autopilot.ts --approve 02\n`);
}

// ------------------------------------------------------------------ main
if (args.includes("--status")) { console.log(JSON.stringify(state, null, 2)); process.exit(0); }
const approve = argVal("--approve");
if (approve) { state.approved = [...new Set([...state.approved, approve])]; save(); log(`fase ${approve} aprovada por você`); }

const primary: AgentName = (argVal("--start") as AgentName) ?? "claude";
const only = argVal("--only");
const preamble = readFileSync(`${DIR}/phases/00-preambulo.md`, "utf8");
log(`🚀 autopilot iniciado${unattended ? " (--unattended)" : ""}; agentes: ${ENABLED.join("+")}; principal: ${primary}; tentativas por fase: ${maxAttempts}`);

for (const phase of PHASES) {
  if (only && phase.id !== only) continue;
  if (phase.unattendedOnly && !unattended) continue;

  if (state.done.includes(phase.id)) {
    if (phase.humanReview && !unattended && !state.approved.includes(phase.id)) {
      writeReviewFile();
      log(`⏸  fase ${phase.id} aguardando SUA revisão: autopilot/REVISAR.md, depois --approve ${phase.id}`);
      process.exit(3);
    }
    continue;
  }

  const body = readFileSync(`${DIR}/phases/${phase.file}`, "utf8");
  const gateList = phase.gates.map((g) => `- \`${g.cmd}\`${g.expect === "fail" ? "  (DEVE falhar nesta fase)" : ""}`).join("\n");
  let feedback = "";
  let attempt = 0;
  // revisão cruzada: começa pelo agente que NÃO escreveu a fase revisada; se ele estiver
  // sem cota, espera até AUTOPILOT_REVIEW_WAIT_MIN (padrão 90) antes de aceitar o mesmo autor
  let preferred: AgentName = phase.reviewerOf ? other(state.by[phase.reviewerOf] ?? primary) : primary;
  if (phase.reviewerOf && ENABLED.includes(preferred) && !available(preferred)) {
    const until = state.cooldownUntil[preferred] ?? 0;
    const maxWait = Number(process.env.AUTOPILOT_REVIEW_WAIT_MIN ?? 90) * 60_000;
    if (until - Date.now() <= maxWait) {
      log(`⏳ revisão cruzada: esperando ${preferred} voltar (~${Math.ceil((until - Date.now()) / 60_000)} min) para não revisar a própria régua`);
      await Bun.sleep(Math.max(until - Date.now(), 1_000));
    } else {
      log(`⚠️  ${preferred} só volta em mais de ${maxWait / 60_000} min; a régua será revisada pelo próprio autor — revise-a você ao voltar`);
    }
  }

  while (attempt < maxAttempts) {
    const agent = await waitForAgent(preferred);
    attempt++;
    const prompt = `${preamble}\n\n${body}\n\nPORTÃO desta fase (rode antes de encerrar):\n${gateList}\n${feedback}`;
    const logFile = `${LOGS}/fase-${phase.id}-tentativa-${attempt}-${agent}.log`;
    log(`▶  fase ${phase.id} · tentativa ${attempt}/${maxAttempts} · ${agent}`);

    const r = await runAgent(agent, prompt, logFile);
    if (r.limited) {
      const until = parseReset(tail(r.output, 40)) ?? Date.now() + cooldownMin * 60_000;
      state.cooldownUntil[agent] = until; save();
      attempt--; // falta de cota não conta como tentativa
      const when = new Date(until).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" });
      log(`⛽ ${agent} sem cota até ~${when}; o outro agente assume a fase ${phase.id}`);
      brokenStrikes[agent] = 0;
      continue;
    }
    if (r.broken) {
      attempt--;
      const n = (brokenStrikes[agent] = (brokenStrikes[agent] ?? 0) + 1);
      log(`🔧 ${agent} falhou na hora (não é cota): ${tail(r.output, 4).replace(/\s+/g, " ").slice(0, 300)}`);
      if (n >= 3) {
        ENABLED.splice(ENABLED.indexOf(agent), 1);
        log(`🔧 ${agent} DESLIGADO nesta execução após 3 falhas imediatas; veja ${logFile}`);
        await notify(`🔧 Autopilot: ${agent} desligado (erro de configuração). Seguindo com ${ENABLED.join("+") || "ninguém"}.`);
        if (ENABLED.length === 0) { log("🚧 nenhum agente funcional; parando"); process.exit(1); }
      } else {
        state.cooldownUntil[agent] = Date.now() + 10 * 60_000; save();
      }
      continue;
    }
    brokenStrikes[agent] = 0;
    if (r.timedOut) log(`⏱  ${agent} excedeu o tempo; avaliando o que ficou pronto`);

    if (!phase.mayEditFrozen) {
      const touched = await revertFrozen();
      if (touched.length) {
        feedback = `\n\nTENTATIVA ANTERIOR REPROVADA: você alterou arquivos congelados (${touched.join(", ")}); ` +
          `as alterações foram revertidas. Corrija o código de produção, não a régua.`;
        log(`🛑 ${agent} mexeu em arquivos congelados (${touched.join(", ")}); revertido`);
        if (unattended) preferred = other(agent);
        continue;
      }
    }

    const g = await runGates(phase);
    writeFileSync(`${LOGS}/fase-${phase.id}-tentativa-${attempt}-portao.log`, g.report);
    if (g.ok) {
      await commit(phase, agent);
      state.done.push(phase.id); state.by[phase.id] = agent; save();
      log(`✅ fase ${phase.id} verde e commitada (${agent})`);
      await notify(`✅ Fase ${phase.id} verde (${agent})`);
      break;
    }
    feedback = `\n\nTENTATIVA ANTERIOR REPROVADA NO PORTÃO (rodado pelo orquestrador):\n\`\`\`\n${tail(g.report, 120)}\n\`\`\`\n` +
      `Investigue a causa raiz e corrija o código de produção. Leia docs/PROGRESS.md: outro agente pode ter trabalhado nesta fase.`;
    log(`❌ portão da fase ${phase.id} falhou (log: autopilot/logs/fase-${phase.id}-tentativa-${attempt}-portao.log)`);
    if (unattended) preferred = other(agent); // olhar novo na próxima tentativa
  }

  if (!state.done.includes(phase.id)) {
    writeFileSync(`${DIR}/BLOQUEADO.md`,
      `# Fase ${phase.id} bloqueada após ${maxAttempts} tentativas\n\nVeja autopilot/logs/fase-${phase.id}-*.log.\n` +
      `Resolva interativamente (claude) e depois rode de novo: bash scripts/run-unattended.sh\n\n## Último portão\n\n${feedback}\n`);
    log(`🚧 fase ${phase.id} bloqueada — leia autopilot/BLOQUEADO.md`);
    await notify(`🚧 Autopilot parou: fase ${phase.id} bloqueada após ${maxAttempts} tentativas`);
    process.exit(1);
  }

  if (phase.humanReview) {
    writeReviewFile();
    if (!unattended && !state.approved.includes(phase.id)) {
      log(`⏸  fase ${phase.id} pronta. Pare e revise: autopilot/REVISAR.md`);
      await notify(`⏸ Fase ${phase.id} pronta: revise os testes de aceitação`);
      process.exit(3);
    }
  }
}

log("🏁 todas as fases solicitadas concluídas");
await notify("🏁 Autopilot terminou todas as fases. Revise autopilot/REVISAR.md e o git log.");
process.exit(0);
