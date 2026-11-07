/**
 * Specs của loader cấu hình (`src/config.ts`).
 *
 * Loader là **fail-closed theo đúng hợp đồng của job cũ**: thiếu Hyperdrive binding là
 * `throw` (cron đỏ ở Past events), không bao giờ "bỏ qua run này". Ghim ở đây:
 *   - cả hai binding bắt buộc, thiếu một trong hai là lỗi với đúng tên binding;
 *   - binding present nhưng sai shape (`connectionString` thiếu/không phải string/rỗng)
 *     cùng một lớp lỗi — không có đường "sai shape thì thử lần nữa";
 *   - **connection string không bao giờ rơi vào message lỗi** — message chỉ nêu tên
 *     binding (SR-001: connection string là admin-path credential).
 *
 * Các cap (`BATCH_SIZE`/`MAX_BATCHES`/…) là hằng số thuật toán, không phải env var —
 * không test nào override được chúng, và `loadPruneJobConfig` tự từ chối giá trị vô nghĩa
 * nếu một mùa sau sửa hằng thành giá trị sai (`assertPositive` chạy ở mọi lần load).
 */

import { describe, expect, it } from 'vitest';

import {
  BATCH_SIZE,
  DB_ACCOUNT_BINDING,
  DB_AUTH_BINDING,
  loadPruneJobConfig,
  MAX_BATCHES,
  MAX_SECONDS,
  PruneJobConfigError,
} from './config';

/** Env hợp lệ tối thiểu — merge `overrides` ĐÈ LÊN thay vì `delete` (oxlint no-dynamic-delete). */
function makeEnv(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    [DB_AUTH_BINDING]: { connectionString: 'postgres://auth-pruner:secret@hd-auth/db-auth' },
    [DB_ACCOUNT_BINDING]: {
      connectionString: 'postgres://account-pruner:secret@hd-account/db-account',
    },
    ...overrides,
  };
}

describe('loadPruneJobConfig', () => {
  it('returns both database bindings when both Hyperdrive bindings are present', () => {
    // Đường hạnh phúc: hai binding đủ shape → trả nguyên object binding để composition
    // root đọc `connectionString` (không copy, không gia công validate lần nữa).
    const config = loadPruneJobConfig(makeEnv({}));
    expect(config.dbAuth.connectionString).toBe('postgres://auth-pruner:secret@hd-auth/db-auth');
    expect(config.dbAccount.connectionString).toBe(
      'postgres://account-pruner:secret@hd-account/db-account',
    );
  });

  it('throws when the auth binding is missing entirely', () => {
    // Fail-closed: thiếu một binding là lỗi mỗi lần chạy (cron đỏ), không "skip kho đó".
    expect(() => loadPruneJobConfig(makeEnv({ [DB_AUTH_BINDING]: undefined }))).toThrow(
      new RegExp(`${DB_AUTH_BINDING}`, 'u'),
    );
  });

  it('throws when the account binding is missing entirely', () => {
    expect(() => loadPruneJobConfig(makeEnv({ [DB_ACCOUNT_BINDING]: undefined }))).toThrow(
      new RegExp(`${DB_ACCOUNT_BINDING}`, 'u'),
    );
  });

  it('rejects a binding that is not an object', () => {
    // Binding bị gán nhầm giá trị scalar — sai shape, cùng lớp lỗi với missing.
    expect(() => loadPruneJobConfig(makeEnv({ [DB_AUTH_BINDING]: 'postgres://x' }))).toThrow(
      PruneJobConfigError,
    );
  });

  it('rejects a binding whose connectionString is absent or not a string', () => {
    // Hyperdrive binding thật luôn có `connectionString`; thiếu nó là shape sai.
    expect(() => loadPruneJobConfig(makeEnv({ [DB_AUTH_BINDING]: {} }))).toThrow(
      PruneJobConfigError,
    );
    expect(() =>
      loadPruneJobConfig(makeEnv({ [DB_ACCOUNT_BINDING]: { connectionString: 42 } })),
    ).toThrow(PruneJobConfigError);
  });

  it('rejects a binding whose connectionString is empty', () => {
    // Rỗng là "có key nhưng không có giá trị" — không hợp lệ hơn missing.
    expect(() =>
      loadPruneJobConfig(makeEnv({ [DB_ACCOUNT_BINDING]: { connectionString: '' } })),
    ).toThrow(PruneJobConfigError);
  });

  it('keeps the binding name and never a credential in every config error message', () => {
    // SR-001: message lỗi của loader đi vào log Worker — nó phải mang **tên binding**,
    // không mang credential. Mỗi đường throw được ghim hai chiều: message khớp đúng
    // nguyên nhân shape, và KHÔNG chứa bất kỳ mảnh nào của DSN.
    const messages: string[] = [];
    const throwsOn = (env: Record<string, unknown>): void => {
      try {
        loadPruneJobConfig(env);
      } catch (error) {
        messages.push((error as Error).message);
        return;
      }
      messages.push('<no throw>');
    };
    throwsOn({});
    throwsOn({ [DB_AUTH_BINDING]: 'postgres://worker:wrong-type@host/x' });
    throwsOn({ [DB_AUTH_BINDING]: { connectionString: '' } });

    // Mỗi đường đều throw (không đường nào rơi vào "<no throw>") — ghim theo số.
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).toContain('DB_AUTH');
      expect(message).not.toContain('postgres://');
      expect(message).not.toContain('wrong-type');
    }
    // Nguyên nhân khác nhau theo đúng shape: missing / not-object / invalid-string.
    expect(messages[0]).toMatch(/DB_AUTH chua dc gan/u);
    expect(messages[1]).toMatch(/DB_AUTH chua dc gan/u);
    expect(messages[2]).toMatch(/DB_AUTH khong the doc connectionString/u);
  });

  it('does not inspect the credential value of a well-shaped binding', () => {
    // Loader không bao giờ nhìn vào giá trị, chỉ nhìn shape — một DSN mang password giả
    // sai (credential thật sai ở tầng Hyperdrive) vẫn đi qua loader; sai credential là
    // việc của identity preflight bên application lib (`pruneTarget`), không phải loader.
    const config = loadPruneJobConfig(
      makeEnv({
        [DB_ACCOUNT_BINDING]: {
          connectionString: 'postgres://account-pruner:leaked-credential@x/y',
        },
      }),
    );
    expect(config.dbAccount.connectionString).toContain('leaked-credential');
  });
});

describe('algorithm cap constants', () => {
  it('keeps BATCH_SIZE and MAX_BATCHES at the legacy script values', () => {
    // Hai cap này giữ nguyên từ `PRUNE_SCRIPT` cũ — đổi chúng là đổi thuật toán (chi phí
    // khoá hàng, khối lượng backlog mỗi run), phải đi qua review chứ không phải một lần
    // chỉnh hằng. Test này là chỗ reviewer thấy diff đỏ.
    expect(BATCH_SIZE).toBe(20_000);
    expect(MAX_BATCHES).toBe(50);
  });

  it('keeps MAX_SECONDS inside the 15-minute cron wall-clock budget', () => {
    // Bảng tính (comment `MAX_SECONDS`): một kho ≤ MAX_SECONDS + 450 (một lô cuối 225+
    // probe 225), hai kho song song ⇒ tổng run = max(kho). MAX_SECONDS = 400 → tổng ≤
    // 850s < 900s trần WK4. Nới MAX_SECONDS qua mốc này là một run có thể bị runtime kill
    // giữa đường — rollback sạch nhưng không có dòng `outcome=` nào để đọc.
    expect(MAX_SECONDS).toBe(400);
    expect(MAX_SECONDS + 450).toBeLessThan(900);
  });
});
