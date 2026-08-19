#!/usr/bin/env node
// ~/.codex/config.toml 에 codex-accounts 프로바이더를 멱등 등록.
// - [model_providers.codex-accounts] 블록이 없으면 파일 끝에 추가
// - 최상위 model_provider 를 codex-accounts 로 지정 (기존 값 교체 또는 맨 위 삽입)
// - 변경 전 config.toml.bak-<timestamp> 백업 생성
//
// 사용: node setup-codex.ts
// 환경: ROUTER_PROXY_URL (기본 http://127.0.0.1:9091), CODEX_HOME (기본 ~/.codex)

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const configPath = join(codexHome, 'config.toml');
const PROVIDER = 'codex-accounts';
const BASE_URL = process.env.ROUTER_PROXY_URL ?? 'http://127.0.0.1:9091';

let text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
const orig = text;

// 1) 프로바이더 정의 블록 (테이블이므로 파일 끝에 두면 항상 유효)
if (!new RegExp(`^\\[model_providers\\.${PROVIDER}\\]`, 'm').test(text)) {
  if (text && !text.endsWith('\n')) text += '\n';
  text += [
    '',
    `[model_providers.${PROVIDER}]`,
    `name = "${PROVIDER}"`,
    `base_url = "${BASE_URL}"`,
    'wire_api = "responses"',
    '',
  ].join('\n');
}

// 2) 최상위 model_provider — 첫 테이블 헤더 이전 영역만 건드린다
const firstTable = text.search(/^\[/m);
const head = firstTable === -1 ? text : text.slice(0, firstTable);
const rest = firstTable === -1 ? '' : text.slice(firstTable);
if (/^model_provider\s*=\s*"[^"]*"\s*$/m.test(head)) {
  text = head.replace(/^model_provider\s*=\s*"[^"]*"\s*$/m, `model_provider = "${PROVIDER}"`) + rest;
} else {
  text = `model_provider = "${PROVIDER}"\n` + head.replace(/^\n+/, '') + rest;
}

if (text === orig) {
  console.log(`이미 설정됨: ${configPath}`);
  process.exit(0);
}

if (existsSync(configPath)) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = `${configPath}.bak-${ts}`;
  copyFileSync(configPath, bak);
  console.log(`백업: ${bak}`);
}
writeFileSync(configPath, text);
console.log(`설정 완료: ${configPath}`);
console.log(`  model_provider = "${PROVIDER}" → ${BASE_URL}`);
