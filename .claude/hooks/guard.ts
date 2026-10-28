#!/usr/bin/env bun
/**
 * PreToolUse guard — barreira determinística contra os atalhos que fariam o agente
 * "passar nos testes" sem garantir as propriedades do desafio.
 *
 * Recebe o JSON do hook em stdin. Exit 0 = permite; exit 2 = bloqueia e o texto de
 * stderr volta para o Claude como motivo. É heurística (regex), não prova: o auditor,
 * as sabotagens e a revisão humana continuam necessários.
 *
 * Escape consciente: iniciar a sessão com ALLOW_PROTECTED_EDITS=1 libera os arquivos
 * congelados (não libera os padrões proibidos de código).
 */

import { FROZEN_PATHS, checkText } from "./rules.ts";

type HookInput = {
  tool_name: string;
  tool_input: {
    file_path?: string;
    content?: string;
    new_string?: string;
    edits?: { new_string?: string }[];
    command?: string;
  };
  cwd?: string;
};

const input: HookInput = JSON.parse(await Bun.stdin.text());
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const violations: string[] = [];

const norm = (p: string) => p.replace(/\\/g, "/");
const rel = (p: string) => {
  const f = norm(p), r = norm(root).replace(/\/+$/, "");
  return (f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length) : f).replace(/^\/+/, "");
};

// ------------------------------------------------------------------ Bash
if (input.tool_name === "Bash") {
  const cmd = input.tool_input.command ?? "";
  const bashRules: [RegExp, string][] = [
    [/--no-verify\b/, "não pule hooks do git (--no-verify)."],
    [/git\s+push\b.*(\s-f\b|--force)/, "push forçado reescreve histórico; peça ao humano."],
    [/git\s+reset\s+--hard/, "reset --hard descarta trabalho; peça ao humano ou use git stash."],
    [/\bDISABLE\s+TRIGGER\b|\bDROP\s+TRIGGER\b/i, "desligar/dropar trigger é desligar uma garantia do schema. Só em migration down revisada."],
    [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, "rm recursivo em diretório raiz/home."],
  ];
  for (const [re, why] of bashRules) if (re.test(cmd)) violations.push(why);
}

// ------------------------------------------------------------- edições
const filePath = input.tool_input.file_path;
if (filePath && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name)) {
  const path = rel(filePath);
  const text = [
    input.tool_input.content ?? "",
    input.tool_input.new_string ?? "",
    ...(input.tool_input.edits ?? []).map((e) => e.new_string ?? ""),
  ].join("\n");

  // 1. arquivos congelados
  if (process.env.ALLOW_PROTECTED_EDITS !== "1" && FROZEN_PATHS.some((re) => re.test(path))) {
    violations.push(
      `${path} está congelado. Os testes de aceitação são a régua: corrija o código de produção. ` +
        `Se o teste contradiz docs/CHALLENGE.md, PARE e explique ao humano citando a seção.`,
    );
  }

  // 2. padrões proibidos (mesmas regras do CI: .claude/hooks/rules.ts)
  violations.push(...checkText(path, text));
}

if (violations.length > 0) {
  console.error("BLOQUEADO pelo guard do projeto (ver CLAUDE.md):\n- " + violations.join("\n- "));
  process.exit(2);
}
process.exit(0);
