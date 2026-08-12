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

# launchd는 절대경로만 허용 → 템플릿의 __HOME__을 $HOME으로 렌더링
render_plist() {
  local src="$1" dst="$2"
  sed "s|__HOME__|$HOME_DIR|g" "$src" > "$dst"
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
  run cp "$SCRIPT_DIR/codex-accounts/proxy.ts" "$SCRIPT_DIR/codex-accounts/login.ts" "$SCRIPT_DIR/codex-accounts/export-tokens.ts" "$SCRIPT_DIR/codex-accounts/db.ts" "$SCRIPT_DIR/codex-accounts/quota.ts" "$SCRIPT_DIR/codex-accounts/control.ts" "$SCRIPT_DIR/codex-accounts/dashboard.html" "$HOME_DIR/.codex-accounts/"
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
else
  say "(dry-run) launchd bootstrap 생략"
fi

say ""
say "설치 완료. 다음을 확인하세요:"
say "  - Command Code 키:  ~/.cc-accounts/add-account.sh <a|b> [key]  (accounts.db 저장)"
say "  - ChatGPT 계정 추가: node ~/.codex-accounts/login.ts  (디바이스 로그인)"
say "  - ChatGPT 토큰 갱신: node ~/.codex-accounts/export-tokens.ts --refresh"
say "  - 사용량 수집:      launchd com.codex-accounts.quota (5분 간격)"
say "  - 제어 API:        http://127.0.0.1:9092/api/accounts (QuotaBar 호환)"
say "  - 프록시 확인:      curl http://127.0.0.1:9090/provider/v1/models  /  9091"
say "  - 데이터:           ~/Documents/codex-accounts/accounts.db (+ encryption.key)"
