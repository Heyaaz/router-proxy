#!/bin/bash
# router-proxy 온보딩 마법사 — 계정 추가 + 클라이언트 설정 안내
# install.sh 이후 실행. 각 단계는 [y/N]로 건너뛸 수 있다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:?HOME is required}"

say() { echo "[setup] $*"; }
ok()   { curl -sf --max-time 2 "$1" >/dev/null 2>&1; }

# node 확인
if ! command -v node >/dev/null 2>&1; then
  echo "[setup] 오류: node를 찾을 수 없습니다. Node 23+ 설치 후 다시 실행하세요 (brew install node)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 23 ]; then
  say "경고: Node $(node --version) — .ts 직접 실행은 Node 23.6+ 권장"
fi

# 프록시 기동 확인 — 안 떠 있으면 install.sh부터
if ! ok http://127.0.0.1:9091/healthz; then
  say "통합 프록시(:9091)가 응답하지 않습니다. 먼저 ./install.sh 를 실행하세요."
  exit 1
fi
say "프록시 확인: 9091 OK$(ok http://127.0.0.1:9090/healthz && echo ', 9090 OK')"

# 비대화형 셸이면 수동 절차만 출력
if [ ! -t 0 ]; then
  cat <<'EOF'
[setup] 비대화형 셸 — 수동 절차:
  ChatGPT 계정:   node ~/.codex-accounts/login.ts
  Command Code:   ~/.cc-accounts/add-account.sh a sk-...
  codex CLI 설정: node ~/.codex-accounts/setup-codex.ts
  대시보드:       http://127.0.0.1:9092/
EOF
  exit 0
fi

ask() { # ask "질문" → 0이면 yes
  local reply
  read -r -p "[setup] $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# 1) ChatGPT 계정
if ask "ChatGPT 계정을 추가할까요? (디바이스 로그인)"; then
  node "$HOME_DIR/.codex-accounts/login.ts"
fi

# 2) Command Code 키
if [ -x "$HOME_DIR/.cc-accounts/add-account.sh" ]; then
  if ask "Command Code 키를 추가할까요?"; then
    read -r -p "[setup] 슬롯 이름 (a/b/c...): " slot
    read -r -p "[setup] API 키 (sk-...): " key
    "$HOME_DIR/.cc-accounts/add-account.sh" "$slot" "$key"
  fi
fi

# 3) codex CLI 설정
if ask "codex CLI가 프록시를 타도록 ~/.codex/config.toml을 설정할까요?"; then
  node "$HOME_DIR/.codex-accounts/setup-codex.ts"
fi

say "완료. 대시보드: http://127.0.0.1:9092/"
say "문제 시: curl http://127.0.0.1:9091/healthz / launchctl kickstart -k gui/\$(id -u)/com.codex-accounts.proxy"
