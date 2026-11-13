/**
 * Kịch bản (j) — fence không-leak trên MỌI captured artifact của lane sau một
 * vòng serving thật: plaintext key consumer và prompt của record không xuất
 * hiện trong log container nào (mock, worker), và plaintext key không nằm ở
 * cột nào của database (chỉ hash). Fence captured-output của chính suite nằm
 * ở runner (`bin/run-system-test.mjs`) — không lặp lại ở đây.
 */

import { describe, expect, it } from 'vitest';

import {
  GATEWAY_DATABASE,
  MOCK_DETERMINISTIC_CONTENT,
  containerLogs,
  laneConsumerApiKey,
  mockContainer,
  psqlCount,
  workerContainer,
} from '../support/lane.mts';

/** Prompt của record — spec 02 đã gửi nó qua serving thật (marker truy được). */
const PROMPT_MARKER = 'e2e-inference-prompt-of-record';

describe('leak fences after real serving (j)', () => {
  it('keeps the consumer key plaintext out of the mock upstream logs', () => {
    const logs = containerLogs(mockContainer());
    expect(logs).not.toContain(laneConsumerApiKey());
    expect(logs).not.toContain('Bearer');
    // Mock log một-bit verdict auth — không giá trị header.
  });

  it('keeps the consumer key plaintext and the prompt out of the worker logs', () => {
    const logs = containerLogs(workerContainer());
    expect(logs).not.toContain(laneConsumerApiKey());
    expect(logs).not.toContain(PROMPT_MARKER);
    expect(logs).not.toContain(MOCK_DETERMINISTIC_CONTENT);
  });

  it('stores the consumer key only as a hash in the gateway database', () => {
    // Plaintext không nằm trong cột key_hash của row nào (hash là SHA-256 hex,
    // plaintext key suite giữ là chuỗi khác hẳn hình dạng đó).
    const plaintextRows = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.api_keys WHERE key_hash = '${laneConsumerApiKey()}'`,
    );
    expect(plaintextRows).toBe(0);
    // Và toàn bộ key_hash trong DB đều ở hình SHA-256 hex.
    const nonHexHashes = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.api_keys WHERE key_hash !~ '^[0-9a-f]{64}$'`,
    );
    expect(nonHexHashes).toBe(0);
  });
});
