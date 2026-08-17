# Codex CLI → 로컬 라우팅 프록시 연결 설정

codex가 `chatgpt.com`에 직접 붙지 않고, 로컬 계정 라우팅 프록시(`codex-accounts` 통합
프록시, 포트 9091)를 타도록 하는 설정 변경 기록.

## 적용 날짜

2026-08-13

## 변경 요약

`~/.codex/config.toml`에 다음 2곳을 추가했다.

1. 최상단 모델 프로바이더 선택:

   ```toml
   model = "gpt-5.6-sol"
   model_provider = "codex-accounts"
   ```

2. 프로바이더 정의 블록:

   ```toml
   [model_providers.codex-accounts]
   name = "codex-accounts"
   base_url = "http://127.0.0.1:9091"
   wire_api = "responses"
   ```

## 프록시에서 대응한 라우팅 변경 (codex-accounts/proxy.ts)

- `wire_api = "responses"`인 codex CLI는 `{base_url}/responses`, `{base_url}/models`로
  요청하므로, 이 경로를 chatgpt 프로바이더(`/backend-api/codex/*`)로 매핑하는 라우트를
  `routeFor()`에 추가.
- `/models?client_version=…` 같은 query string이 잘리지 않도록 `handle()`에서
  `URL.pathname`/`URL.search`를 분리해 업스트림에 재결합.
- `/v1/responses`, `/v1/models`(OpenAI 호환 경로, GJC models.yml 등이 사용)도 동일하게
  chatgpt 프로바이더로 라우팅. GET은 body가 없어 모델 매칭이 불가하므로 정적 라우트가 유일한 진입로다.
- `/v1/*` 모델 패턴 매칭은 catch-all(`.*`) 프로바이더를 순회 마지막으로 정렬 —
  등록 순서가 아니라 패턴 구체성이 우선한다 (`loadFromDb()`).
- `GET /healthz` 로컬 진단 엔드포인트: `{"ok":true,"providers":{...},"uptime_s":...}` —
  프록시 기동/계정풀 상태 원샷 확인. 업스트림 미경유.
- ROUTE 트레이스에 `model` 필드 추가 — 어떤 모델이 어느 프로바이더/계정으로 갔는지 로그로 추적 가능.
- `env_key` 없이도 동작하도록 `~/.codex/auth.json` 토큰 자동 주입:
  ChatGPT 데스크톱 앱이 갱신해주는 `auth.json`의 `access_token`을 읽어, 프록시가
  선택한 계정과 `account_id`가 일치할 때만 그 토큰으로 교체해 업스트림에 전달.
  계정 로테이션(a/b/c 사용량 분산)과 사용량 귀속은 그대로 유지된다.

## auth.json 토큰 주입 규칙 (중요)

- codex CLI가 `~/.codex/auth.json`에 직접 붙던 인증 흐름은 그대로 두되, 프록시가
  대신 중계한다.
- 주입 조건: `auth.json`의 `tokens.access_token` + `tokens.account_id`가 존재하고,
  프록시가 선택한 계정의 `account_id`와 일치할 때만.
- 일치하지 않으면 기존 방식대로 `accounts.db`의 해당 계정 토큰을 사용.

## 다른 설정 파일

Orca 터미널 등 모든 클라이언트가 `real-home`(`~/.codex/config.toml`)을 바라보므로
이 설정 하나로 적용된다. 별도 런타임 홈
(`~/Library/Application Support/orca/codex-runtime-home/home/config.toml`)은
`~/.codex/config.toml`의 사본이며, MCP 서버 설정 동기화 시 함께 수정했다.

## 인프런 MCP 제거

이 변경과 함께 `[mcp_servers.inflearn]` 블록을 두 파일에서 제거했다
(OAuth `invalid_grant` 재시도 에러가 매 세션마다 로그에 찍혀서).
`mcp.inflearn.com` OAuth 리프레시 토큰은 재발급되지 않는 상태였다.

## 검증

- `codex exec`로 `model_provider = "codex-accounts"` 선택 확인
- 프록시 로그에 `[chatgpt:a/b/c] POST /backend-api/codex/responses -> 200` 기록
- `env` 변수 없이 codex 실행 성공 (`CODEX_AUTH_TOKEN` 미설정 상태 포함)

## 참고

- 배포된 프록시 파일: `~/.codex-accounts/proxy.ts` (launchd: `com.codex-accounts.proxy`)
- 설정 백업: `~/.codex/config.toml.bak-20260813-122115`
- 기존의 `~/.codex/auth.json` 인증 방식과 양립하므로, codex CLI의 기존 세션/설정은
  그대로 유지된다.
