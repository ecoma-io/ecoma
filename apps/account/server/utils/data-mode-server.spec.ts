import { describe, expect, it } from 'vitest';

import { DATA_MODE_MOCK_IN_ARTIFACT_REASON, resolveServerDataMode } from './data-mode-server';

/**
 * Matrix gate server-side của seam `DATA_MODE`.
 *
 * Resolver phía app âm thầm fail về `real`; gate này phải **lên tiếng** khi
 * artifact bị cấu hình mock — boot 503 qua plugin config, `/ready` 503 với
 * reason ổn định. Điểm cần bắt: phân biệt "không cấu hình" (im lặng, hợp lệ)
 * với "artifact có yêu cầu mock" (lỗi cấu hình phải chặn).
 */
describe('resolveServerDataMode', () => {
  it('marks an explicit mock request as mock only under dev', () => {
    expect(resolveServerDataMode('mock', true)).toEqual({ kind: 'mock', devOnly: true });
  });

  it('treats an explicit mock request in an artifact as a real mode with the flag raised', () => {
    expect(resolveServerDataMode('mock', false)).toEqual({
      kind: 'real',
      mockInArtifact: true,
    });
  });

  it('stays silent for unconfigured config in both runtimes', () => {
    // Chưa cấu hình ở dev ⇒ mock hợp lệ theo mặc định môi trường; ở artifact ⇒
    // real. Cả hai đều KHÔNG raise flag — flag chỉ dành cho artifact bị đặt biến.
    expect(resolveServerDataMode(undefined, true)).toEqual({ kind: 'mock', devOnly: true });
    expect(resolveServerDataMode(undefined, false)).toEqual({
      kind: 'real',
      mockInArtifact: false,
    });
    expect(resolveServerDataMode('', false)).toEqual({ kind: 'real', mockInArtifact: false });
  });

  it.each([
    ['wrong case', 'Mock'],
    ['trailing whitespace', 'mock '],
    ['misspelled', 'mok'],
    ['non-string', 1],
    ['explicit real', 'real'],
  ])('a non-mock set value (%s) never raises the flag', (_label, raw) => {
    // Giá trị không resolve ra mock ở bất kỳ môi trường nào không phải là yêu
    // cầu mock — fail-closed của resolver đã xử lý; gate chỉ chặn yêu cầu mock
    // tường minh trong artifact.
    expect(resolveServerDataMode(raw, false)).toEqual({ kind: 'real', mockInArtifact: false });
  });

  it('exposes a stable English reason code for the ready gate', () => {
    expect(DATA_MODE_MOCK_IN_ARTIFACT_REASON).toBe('data_mode_mock_in_artifact');
  });
});
