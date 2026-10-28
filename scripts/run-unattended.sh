#!/usr/bin/env bash
# =============================================================================
# Liga o autopilot e vai embora.
#
#   bash scripts/run-unattended.sh            # inicia (ou retoma) em segundo plano
#   bash scripts/run-unattended.sh --stop     # para tudo
#   bash scripts/run-unattended.sh --status   # mostra o estado e as últimas linhas do log
#
# O que este script faz:
#   1. confere pré-requisitos (git, bun, docker rodando, claude e codex logados);
#   2. cria o repositório git se ainda não existir (primeiro commit = o kit);
#   3. impede o computador de dormir enquanto roda (caffeinate / systemd-inhibit);
#   4. roda o autopilot --unattended dentro de um "cão de guarda": se o processo cair
#      por um erro inesperado, ele reinicia sozinho; se terminar ou bloquear, para.
# Tudo continua de onde parou: o estado fica em autopilot/state.json.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PIDFILE="autopilot/watchdog.pid"
mkdir -p autopilot/logs

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PIDFILE" ]]; then
    kill -- "-$(cat "$PIDFILE")" 2>/dev/null || kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  pkill -f "bun run scripts/autopilot.ts --unattended" 2>/dev/null || true
  echo "Autopilot parado."
  exit 0
fi

if [[ "${1:-}" == "--status" ]]; then
  bun run scripts/autopilot.ts --status || true
  echo "---- últimas linhas do log ----"
  tail -n 25 autopilot/autopilot.log 2>/dev/null || echo "(sem log ainda)"
  exit 0
fi

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "O autopilot já está rodando (PID $(cat "$PIDFILE")). Use --status ou --stop."
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

# "timeout" não existe no macOS padrão; usa gtimeout (coreutils) ou roda sem limite
TO=()
if command -v timeout >/dev/null 2>&1; then TO=(timeout 180)
elif command -v gtimeout >/dev/null 2>&1; then TO=(gtimeout 180); fi

say "1/4 Conferindo pré-requisitos"
for c in git bun docker claude; do
  command -v "$c" >/dev/null 2>&1 || fail "não encontrei '$c' no PATH."
done
docker info >/dev/null 2>&1 || fail "o Docker não está rodando. Abra o Docker Desktop (ou 'sudo systemctl start docker') e rode de novo."

echo "  testando login do Claude Code…"
if ! ${TO[@]+"${TO[@]}"} claude -p "Responda apenas: OK" --max-turns 1 >/dev/null 2>&1; then
  fail "o Claude Code não respondeu. Rode 'claude' uma vez, faça login e tente de novo."
fi
echo "  ✔ Claude Code ok"

HAS_CODEX=1
if command -v codex >/dev/null 2>&1; then
  echo "  testando login do Codex…"
  if ! ${TO[@]+"${TO[@]}"} codex exec --skip-git-repo-check "Responda apenas: OK" >/dev/null 2>&1; then
    echo "  ⚠️  o Codex não respondeu (login?). Vou rodar só com o Claude; sem cota, ele espera."
    HAS_CODEX=0
  else
    echo "  ✔ Codex ok"
  fi
else
  echo "  ⚠️  Codex não instalado. Vou rodar só com o Claude; sem cota, ele espera."
  HAS_CODEX=0
fi

say "2/4 Repositório git"
cp -f CLAUDE.md AGENTS.md 2>/dev/null || true   # Codex lê AGENTS.md (cópia; symlink não sobrevive ao Windows)
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -q
  git add -A
  git -c user.name="${GIT_AUTHOR_NAME:-autopilot}" -c user.email="${GIT_AUTHOR_EMAIL:-autopilot@local}" \
    commit -qm "chore: kit de trabalho e especificação"
  echo "  ✔ repositório criado com o kit como primeiro commit"
else
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A && git commit -qm "chore: estado antes do autopilot" && echo "  ✔ mudanças pendentes commitadas"
  fi
  echo "  ✔ repositório ok ($(git log --oneline | wc -l | tr -d ' ') commits)"
fi
git config core.autocrlf false      # não converter LF→CRLF (scripts .sh quebrariam)
git config user.name >/dev/null 2>&1 || git config user.name "autopilot"
git config user.email >/dev/null 2>&1 || git config user.email "autopilot@local"

say "3/4 Mantendo o computador acordado"
KEEP=()
if command -v caffeinate >/dev/null 2>&1; then
  KEEP=(caffeinate -dimsu); echo "  ✔ caffeinate (macOS)"
elif command -v systemd-inhibit >/dev/null 2>&1; then
  if systemd-inhibit --what=idle:sleep --who=autopilot --why=teste true >/dev/null 2>&1; then
    KEEP=(systemd-inhibit --what=idle:sleep --who=autopilot --why="projeto rodando" --mode=block)
    echo "  ✔ systemd-inhibit (Linux)"
  else
    echo "  ⚠️  systemd-inhibit sem permissão; desative a suspensão automática manualmente."
  fi
else
  echo "  ⚠️  não achei como impedir a suspensão. Desative a suspensão automática do sistema manualmente."
fi

say "4/4 Iniciando em segundo plano"
AGENTS="claude,codex"
[[ "$HAS_CODEX" == "0" ]] && AGENTS="claude"

cat > autopilot/watchdog.sh <<EOF
#!/usr/bin/env bash
cd "$ROOT"
restarts=0
while true; do
  AUTOPILOT_AGENTS="$AGENTS" bun run scripts/autopilot.ts --unattended
  code=\$?
  case \$code in
    0) echo "[watchdog] terminou com sucesso"; break ;;
    1) echo "[watchdog] fase bloqueada; parando (veja autopilot/BLOQUEADO.md)"; break ;;
    3) echo "[watchdog] aguardando revisão humana"; break ;;
    *) restarts=\$((restarts+1))
       echo "[watchdog] saída inesperada (\$code); reinício \$restarts em 60 s"
       [[ \$restarts -ge 20 ]] && { echo "[watchdog] reinícios demais; parando"; break; }
       sleep 60 ;;
  esac
done
rm -f "$ROOT/$PIDFILE"
EOF
chmod +x autopilot/watchdog.sh

FOREGROUND=0
[[ "${1:-}" == "--foreground" ]] && FOREGROUND=1
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) FOREGROUND=1 ;; esac   # Windows: janela precisa ficar aberta

if [[ "$FOREGROUND" == "1" ]]; then
  echo $$ > "$PIDFILE"
  cat <<MSG
  ✔ rodando NESTA janela.

  >>> NÃO FECHE ESTA JANELA. Pode minimizar. <<<
  O progresso aparece aqui e em autopilot/autopilot.log. Para parar: Ctrl+C.

MSG
  ${KEEP[@]+"${KEEP[@]}"} bash autopilot/watchdog.sh 2>&1 | tee -a autopilot/run.out
  exit 0
fi

if command -v setsid >/dev/null 2>&1; then
  nohup setsid ${KEEP[@]+"${KEEP[@]}"} bash autopilot/watchdog.sh > autopilot/run.out 2>&1 < /dev/null &
else
  nohup ${KEEP[@]+"${KEEP[@]}"} bash autopilot/watchdog.sh > autopilot/run.out 2>&1 < /dev/null &
fi
echo $! > "$PIDFILE"

sleep 3
echo "  ✔ rodando (PID $(cat "$PIDFILE"))."
cat <<MSG

Pode ir. Para acompanhar quando voltar (ou agora):
  tail -f autopilot/autopilot.log          # linha do tempo ao vivo (Ctrl+C sai sem parar)
  bash scripts/run-unattended.sh --status  # resumo
  bash scripts/run-unattended.sh --stop    # parar tudo
  git log --oneline                        # uma linha por fase concluída

MSG
