#!/bin/bash
# 계정 추가/교체: ~/.cc-accounts/add-account.sh <a|b|c> [apiKey]
#  - apiKey 인자 없이 실행하면: 브라우저 로그인 안내 → 로그인 후 auth.json에서 키 추출
#  - apiKey를 인자로 주면: 그냥 그 키를 accounts.db에 저장
set -euo pipefail

SLOT="${1:?usage: add-account.sh <a|b|c> [apiKey]}"
DB="$HOME/.codex-accounts/db.ts"

if [[ $# -ge 2 ]]; then
  KEY="$2"
else
  if [[ -f "$HOME/.commandcode/auth.json" ]]; then
    echo "기존 auth.json 발견. 계정 전환을 위해 삭제하고 브라우저 로그인합니다."
    echo "  실행: rm ~/.commandcode/auth.json && cmd login"
    echo "  로그인 완료 후 아무 키나 누르세요..."
    read -r -s -p ""
  else
    echo "브라우저 로그인 실행: cmd login"
  fi
  rm -f "$HOME/.commandcode/auth.json"
  cmd login
  KEY=$(node -e "const j=require(process.env.HOME+'/.commandcode/auth.json'); process.stdout.write(j.apiKey||'')")
fi

node --no-warnings "$DB" add-commandcode "$SLOT" "$KEY"
echo "✔ $SLOT 저장됨 (accounts.db, 프록시가 5초 내 자동 로드)"
