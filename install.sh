#!/bin/bash
# router-proxy 설치 스크립트 — HOME 기준, 절대경로 불필요
#
# 사용:
#   ./install.sh            기본 설치 (cc + codex 프록시 + quota 수집기)
#   ./install.sh --dry-run  실제 변경 없이 진행 상황만 출력
#   ./install.sh --uninstall  설치된 프록시/plist 제거
#
# 설치 내용:
#   1. 스크립트 복사: ~/.cc-accounts/, ~/.codex-accounts/
#   2. plist 생성:    ~/Library/LaunchAgents/com.*.plist (템플릿 렌더링)
#   3. 데이터 디렉토리: ~/Documents/codex-accounts (accounts.db + encryption.key)
#   4. launchd 등록:  com.cc-accounts.proxy (:9090), com.codex-accounts.proxy (:9091),
#                     com.codex-accounts.quota (5분 간격 사용량 수집)

set -euo pipefail

# 이 스크립트 위치 기준으로 소스 경로 계산 (어디서 실행해도 동작)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:?HOME is required}"
# launchd는 PATH가 없으므로 node 절대경로를 plist에 렌더링 (Homebrew 외 설치도 지원)
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[install] 오류: node를 찾을 수 없습니다. Node 23+ 설치 후 다시 실행하세요 (brew install node)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 23 ]; then
  echo "[install] 경고: Node $(node --version) 감지 — .ts 직접 실행(type stripping)은 Node 23.6+ 권장" >&2
fi

INSTALL_CC=true
INSTALL_CODEX=true
DRY_RUN=false
UNINSTALL=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --uninstall) UNINSTALL=true ;;
    *) echo "알 수 없는 인자: $arg" >&2; exit 2 ;;
  esac
done

say() { echo "[install] $*"; }
run() {
  if [ "$DRY_RUN" = true ]; then
    say "(dry-run) $*"
  else
    "$@"
  fi
}

# launchd는 절대경로만 허용 → 템플릿의 __HOME__/__NODE__를 설치 시점 값으로 렌더링
render_plist() {
  local src="$1" dst="$2"
  sed -e "s|__HOME__|$HOME_DIR|g" -e "s|__NODE__|$NODE_BIN|g" "$src" > "$dst"
  say "plist 생성: $dst"
}

ensure_dirs() {
  for d in "$@"; do
    if [ ! -d "$d" ]; then
      run mkdir -p "$d"
      say "디렉토리 생성: $d"
    fi
  done
}

if [ "$UNINSTALL" = true ]; then
  for label in com.cc-accounts.proxy com.codex-accounts.proxy com.codex-accounts.quota com.codex-accounts.control; do
    run launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  done
  for f in com.cc-accounts.proxy com.codex-accounts.proxy com.codex-accounts.quota com.codex-accounts.control; do
    rm -f "$HOME_DIR/Library/LaunchAgents/$f.plist"
    say "plist 제거: $HOME_DIR/Library/LaunchAgents/$f.plist"
  done
  say "uninstall 완료 (스크립트/데이터는 보존: ~/.cc-accounts, ~/.codex-accounts, ~/Documents/codex-accounts)"
  exit 0
fi

# 1) 스크립트 복사
if [ "$INSTALL_CC" = true ]; then
  ensure_dirs "$HOME_DIR/.cc-accounts"
  run cp "$SCRIPT_DIR/cc-accounts/proxy.ts" "$SCRIPT_DIR/cc-accounts/add-account.sh" "$SCRIPT_DIR/cc-accounts/cc" "$SCRIPT_DIR/codex-accounts/db.ts" "$HOME_DIR/.cc-accounts/"
  run chmod +x "$HOME_DIR/.cc-accounts/add-account.sh" "$HOME_DIR/.cc-accounts/cc"
  say "Command Code 프록시 설치: ~/.cc-accounts/ (:9090)"
fi

if [ "$INSTALL_CODEX" = true ]; then
  ensure_dirs "$HOME_DIR/.codex-accounts"
  run cp "$SCRIPT_DIR/codex-accounts/proxy.ts" "$SCRIPT_DIR/codex-accounts/login.ts" "$SCRIPT_DIR/codex-accounts/export-tokens.ts" "$SCRIPT_DIR/codex-accounts/db.ts" "$SCRIPT_DIR/codex-accounts/quota.ts" "$SCRIPT_DIR/codex-accounts/control.ts" "$SCRIPT_DIR/codex-accounts/dashboard.html" "$SCRIPT_DIR/codex-accounts/setup-codex.ts" "$HOME_DIR/.codex-accounts/"
  say "통합 프록시 + quota + control 설치: ~/.codex-accounts/ (:9091, :9092)"
fi

# 2) plist 생성 (절대경로는 설치 시점에 $HOME으로 렌더링)
ensure_dirs "$HOME_DIR/Library/LaunchAgents"
if [ "$INSTALL_CC" = true ]; then
  run render_plist "$SCRIPT_DIR/launchd/com.cc-accounts.proxy.plist.template" "$HOME_DIR/Library/LaunchAgents/com.cc-accounts.proxy.plist"
fi
if [ "$INSTALL_CODEX" = true ]; then
  run render_plist "$SCRIPT_DIR/launchd/com.codex-accounts.proxy.plist.template" "$HOME_DIR/Library/LaunchAgents/com.codex-accounts.proxy.plist"
  run render_plist "$SCRIPT_DIR/launchd/com.codex-accounts.quota.plist.template" "$HOME_DIR/Library/LaunchAgents/com.codex-accounts.quota.plist"
  run render_plist "$SCRIPT_DIR/launchd/com.codex-accounts.control.plist.template" "$HOME_DIR/Library/LaunchAgents/com.codex-accounts.control.plist"
fi

# 3) 데이터 디렉토리 (accounts.db + encryption.key)
ensure_dirs "$HOME_DIR/Documents/codex-accounts"

# 4) launchd 등록
if [ "$DRY_RUN" = false ]; then
  if [ "$INSTALL_CC" = true ]; then
    launchctl bootout "gui/$(id -u)/com.cc-accounts.proxy" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME_DIR/Library/LaunchAgents/com.cc-accounts.proxy.plist"
    say "launchd 등록: com.cc-accounts.proxy"
  fi
  if [ "$INSTALL_CODEX" = true ]; then
    launchctl bootout "gui/$(id -u)/com.codex-accounts.proxy" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME_DIR/Library/LaunchAgents/com.codex-accounts.proxy.plist"
    say "launchd 등록: com.codex-accounts.proxy"
    launchctl bootout "gui/$(id -u)/com.codex-accounts.quota" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME_DIR/Library/LaunchAgents/com.codex-accounts.quota.plist"
    say "launchd 등록: com.codex-accounts.quota"
    launchctl bootout "gui/$(id -u)/com.codex-accounts.control" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME_DIR/Library/LaunchAgents/com.codex-accounts.control.plist"
    say "launchd 등록: com.codex-accounts.control"
  fi
  # 헬스체크 — 기동 실패를 설치 시점에 바로 알린다
  check() { # check <url> <이름>
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sf --max-time 1 "$1" >/dev/null 2>&1; then
        say "헬스체크 OK: $2 ($1)"
        return 0
      fi
      sleep 1
    done
    say "경고: 헬스체크 실패: $2 ($1) — 로그 확인: ~/.codex-accounts/*.err.log, ~/.cc-accounts/*.err.log"
    return 1
  }
  HEALTH_FAILED=false
  if [ "$INSTALL_CC" = true ]; then
    check http://127.0.0.1:9090/healthz "cc 프록시" || HEALTH_FAILED=true
  fi
  if [ "$INSTALL_CODEX" = true ]; then
    check http://127.0.0.1:9091/healthz "통합 프록시" || HEALTH_FAILED=true
    check http://127.0.0.1:9092/api/health "제어 API" || HEALTH_FAILED=true
  fi
  if [ "$HEALTH_FAILED" = true ]; then
    say "일부 서비스가 응답하지 않습니다. 위 로그를 확인하세요."
  fi
else
  say "(dry-run) launchd bootstrap 생략"
fi

say ""
say "설치 완료. 다음 단계:"
say "  - 온보딩 마법사:    ./setup.sh  (계정 추가 + codex CLI 설정 안내)"
say "  - ChatGPT 계정 추가: node ~/.codex-accounts/login.ts  (디바이스 로그인)"
say "  - Command Code 키:  ~/.cc-accounts/add-account.sh <a|b> [key]  (accounts.db 저장)"
say "  - codex CLI 설정:   node ~/.codex-accounts/setup-codex.ts  (~/.codex/config.toml 자동 설정)"
say "  - ChatGPT 토큰 갱신: node ~/.codex-accounts/export-tokens.ts --refresh"
say "  - 사용량 수집:      launchd com.codex-accounts.quota (5분 간격)"
say "  - 대시보드/제어 API: http://127.0.0.1:9092/  (QuotaBar: /api/accounts)"
say "  - 프록시 확인:      curl http://127.0.0.1:9091/healthz  /  :9090/healthz"
say "  - 데이터:           ~/Documents/codex-accounts/accounts.db (+ encryption.key)"
