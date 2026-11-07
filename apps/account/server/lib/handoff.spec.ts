/**
 * Unit test cho `server/lib/handoff.ts` — phần thuần: TTL, hash handle và
 * phép so khớp binding với session đang trình X.
 *
 * Các hàm persistence (`bindHandleFirst`, `carryHandoffToNewSession`,
 * `consumeHandoff`, ...) chạy trong integration test (`handoff.spec.ts`,
 * `bff-routes-e2e.spec.ts`) vì giá trị của chúng nằm ở tính nguyên tử của
 * `INSERT ... ON CONFLICT` và của transaction rotate với PostgreSQL thật.
 */

import { describe, expect, it } from 'vitest';

import {
  LOGIN_HANDOFF_TTL_SECONDS,
  checkHandoffBinding,
  hashHandle,
  type LoginHandoffRow,
} from './handoff';

const HANDLE_X = 'X-opaque-handle-value-from-auth';

function handoffRow(overrides: Partial<LoginHandoffRow> = {}): LoginHandoffRow {
  return {
    handle_hash: 'sha256-hex-of-handle-x',
    session_ref: 'asr-presenting',
    state: 'bound',
    expires_at: new Date(Date.now() + 300_000),
    ...overrides,
  };
}

describe('LOGIN_HANDOFF_TTL_SECONDS', () => {
  it('pins the short TTL to the auth transaction TTL (10 minutes)', () => {
    // §3.6: "`expires_at` — TTL ngắn, bằng TTL transaction phía auth".
    // `TRANSACTION_TTL_MS` của `libs/auth-application` là 10 phút.
    expect(LOGIN_HANDOFF_TTL_SECONDS).toBe(600);
  });
});

describe('hashHandle', () => {
  it('is a SHA-256 hex digest, deterministic and distinct per handle', async () => {
    const hash = await hashHandle(HANDLE_X);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashHandle(HANDLE_X)).toBe(hash);
    expect(await hashHandle(`${HANDLE_X}-other`)).not.toBe(hash);
  });

  it('hashes the same value the same way hashSessionIdentifier does', async () => {
    // Cột `login_handoffs.handle_hash` và `account_sessions.id_hash` không chia
    // sẻ thuật toán với nhau, nhưng **cùng một dạng giá trị hex SHA-256** theo
    // tài liệu cột DB — hai nơi cùng hashing SHA-256 hex là điều kiện của mọi
    // phép so khớp hash trong app.
    const { createHash } = await import('node:crypto');
    expect(await hashHandle(HANDLE_X)).toBe(createHash('sha256').update(HANDLE_X).digest('hex'));
  });
});

describe('checkHandoffBinding', () => {
  it('rejects a handle that was never bound', () => {
    // Bảng trống ⇒ `missing` — `/login` không đi qua luồng bind, handoff không
    // có gì để so khớp và fail-closed.
    expect(checkHandoffBinding(null, { sessionRef: 'asr-presenting', nowMs: Date.now() })).toEqual({
      kind: 'missing',
    });
  });

  it('rejects a binding that points to a different session (FR-006c3)', () => {
    // Chính đạo nghĩa của "session khác trình X" — tiền của T-14e/ac-008b3.
    const row = handoffRow({ session_ref: 'asr-first' });
    expect(checkHandoffBinding(row, { sessionRef: 'asr-second', nowMs: Date.now() })).toEqual({
      kind: 'binding_mismatch',
    });
  });

  it('checks the session mismatch BEFORE terminal state, so the reason does not leak binding state', () => {
    // Hai session khác nhau và binding đã `consumed`: mismatch là thông tin
    // quan trọng hơn — session sai phải nhận đúng mã "sai session".
    const row = handoffRow({ session_ref: 'asr-first', state: 'consumed' });
    expect(checkHandoffBinding(row, { sessionRef: 'asr-second', nowMs: Date.now() })).toEqual({
      kind: 'binding_mismatch',
    });
  });

  it('rejects a consumed handoff (FR-006d2: no path to reuse)', () => {
    const row = handoffRow({ state: 'consumed' });
    expect(checkHandoffBinding(row, { sessionRef: 'asr-presenting', nowMs: Date.now() })).toEqual({
      kind: 'unusable',
    });
  });

  it('rejects an expired handoff state even before TTL comparison', () => {
    const row = handoffRow({ state: 'expired' });
    expect(checkHandoffBinding(row, { sessionRef: 'asr-presenting', nowMs: Date.now() })).toEqual({
      kind: 'unusable',
    });
  });

  it('rejects a bound handoff past its TTL, without trusting any state flag', () => {
    // TTL so trực tiếp với `expires_at` — hàng chưa được mark `expired` vẫn
    // chết đúng mốc (bất kể mark hygiene đã chạy hay chưa).
    const row = handoffRow({ expires_at: new Date(Date.now() - 1_000) });
    expect(checkHandoffBinding(row, { sessionRef: 'asr-presenting', nowMs: Date.now() })).toEqual({
      kind: 'unusable',
    });
  });

  it('matches a bound handoff held by the presenting session inside TTL', () => {
    const row = handoffRow({});
    expect(checkHandoffBinding(row, { sessionRef: 'asr-presenting', nowMs: Date.now() })).toEqual({
      kind: 'matched',
    });
  });

  it('matches a session_rotated handoff held by the inheriting session', () => {
    // Sau verify rotate, binding thuộc về session mới (FR-006c4) — session mới
    // là bên trình X hợp lệ ở handoff.
    const row = handoffRow({ state: 'session_rotated' });
    expect(checkHandoffBinding(row, { sessionRef: 'asr-presenting', nowMs: Date.now() })).toEqual({
      kind: 'matched',
    });
  });
});
