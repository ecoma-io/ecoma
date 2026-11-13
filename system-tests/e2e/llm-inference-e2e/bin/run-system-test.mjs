#!/usr/bin/env node
/**
 * Runner của suite E2E inference — target `system-test` gọi file này, KHÔNG
 * gọi vitest trực tiếp. Ba việc, đúng thứ tự:
 *
 * 1. Đọc trạng thái lane qua entry `lane.ts state` của `deploys/llm-api-deploy`
 *    (spawn, KHÔNG inherit stdout): envelope `LANE_STATE=<json>` một dòng mang
 *    namespace + network + owner sub + plaintext key consumer. Plaintext đi
 *    qua đây là ĐƯỜNG DUY NHẤT key vào suite — qua env của process vitest,
 *    không qua file, không qua argv, không qua log.
 * 2. Chạy vitest với env `LLM_E2E_*`, bắt stdout/stderr (không inherit).
 * 3. FENCE không-leak: captured output của suite KHÔNG được chứa plaintext key
 *    (fence trúng là exit 1 và output bị GIỮ — không forward). Output sạch thì
 *    forward nguyên văn và forward exit code của vitest.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '../../..');
const deployDir = path.join(repoRoot, 'deploys', 'llm-api-deploy');

const LANE_STATE_PREFIX = 'LANE_STATE=';

function fail(message) {
  console.error(`[llm-inference-e2e] ${message}`);
  process.exit(1);
}

// --- 1. Trạng thái lane ------------------------------------------------------

const state = spawnSync('npx', ['tsx', 'lane.ts', 'state'], {
  cwd: deployDir,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (state.error !== undefined && state.error !== null) {
  fail(`reading lane state failed: ${state.error.message}`);
}
if (state.status !== 0) {
  // stderr của lane state là log người đọc (không secret) — forward để debug.
  process.stderr.write(state.stderr);
  fail(`lane.ts state exited with ${String(state.status)} — run test-lane-up first`);
}
const stateLine = state.stdout.split('\n').find((line) => line.startsWith(LANE_STATE_PREFIX));
if (stateLine === undefined) {
  fail('lane.ts state printed no LANE_STATE= envelope on stdout; the stdout contract is broken');
}
let laneState;
try {
  laneState = JSON.parse(stateLine.slice(LANE_STATE_PREFIX.length));
} catch {
  fail('LANE_STATE= envelope does not parse as JSON; the lane state contract is broken');
}
for (const field of ['namespace', 'networkName', 'tenantOwnerSub', 'consumerApiKey']) {
  if (typeof laneState[field] !== 'string' || laneState[field] === '') {
    fail(`LANE_STATE envelope carries no ${field} string; the lane state contract is broken`);
  }
}

// --- 2. Vitest với env lane --------------------------------------------------

const env = {
  ...process.env,
  LLM_E2E_NAMESPACE: laneState.namespace,
  LLM_E2E_NETWORK: laneState.networkName,
  LLM_E2E_TENANT_OWNER_SUB: laneState.tenantOwnerSub,
  LLM_E2E_CONSUMER_API_KEY: laneState.consumerApiKey,
};
const vitest = spawnSync('npx', ['vitest', 'run'], {
  cwd: projectRoot,
  encoding: 'utf8',
  env,
  maxBuffer: 64 * 1024 * 1024,
});

// --- 3. Fence + forward ------------------------------------------------------

const captured = `${vitest.stdout ?? ''}\n${vitest.stderr ?? ''}`;
if (captured.includes(laneState.consumerApiKey)) {
  // Fence trúng: KHÔNG forward output (nó mang plaintext), chỉ nêu hiện tượng.
  console.error(
    '[llm-inference-e2e] leak fence tripped: the consumer api key plaintext appeared in captured suite output; the output is withheld — ' +
      'inspect the failing assertion that echoed it (suite output must carry metadata only)',
  );
  process.exit(1);
}

process.stdout.write(vitest.stdout ?? '');
process.stderr.write(vitest.stderr ?? '');
if (vitest.error !== undefined && vitest.error !== null) {
  fail(`starting vitest failed: ${vitest.error.message}`);
}
process.exit(vitest.status ?? 1);
