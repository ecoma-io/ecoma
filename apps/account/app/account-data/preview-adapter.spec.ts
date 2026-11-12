/**
 * Bất biến của adapter preview — mặt ghép giữa dữ liệu mock và auth thật.
 *
 * ⚠️ Adapter preview chỉ hợp lệ khi nó giữ **đúng hai nguồn**: dữ liệu từ mock
 * (ephemeral, banner `isPreview`), auth + security từ adapter thật. Mọi khẳng
 * định dưới đây bảo vệ một nửa của phép ghép — lệch một nửa là lộ lại đúng lỗ
 * hổng mà Issue #123 vá: auth chạy bản in-memory trong khi người dùng tin rằng
 * họ đang trong luồng thật.
 */
import { describe, expect, it, vi } from 'vitest';

import { createPreviewAccountAdapter } from './preview-adapter';

describe('preview adapter', () => {
  it('routes the auth flows it exercises through the real BFF path, not an in-memory fixture', async () => {
    // Probe hành vi thay vì so sánh hàm: mỗi factory call tạo instance mới,
    // nên so sánh tham chiếu không bao giờ khớp. Điểm bất biến thật sự là **đi
    // qua đâu**: mọi phương thức auth của preview phải gọi đường BFF thật và —
    // khi BFF chết (500 ở đây) — thất bại trung thực thay vì trả fixture thành
    // công từ bộ nhớ.
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        paths.push(String(input));
        return new Response(null, { status: 500 });
      }),
    );
    try {
      const preview = createPreviewAccountAdapter();

      const challenge = await preview.requestLoginChallenge('user@example.com', 'opaque-handle');
      // Verify không fetch: challenge trả 500 nên phiên chưa nhớ email pending —
      // nhánh "no challenge requested" cũng là một refusal thật, không fixture.
      expect(await preview.verifyLoginCode('123456').then((r) => r.ok)).toBe(false);
      expect((await preview.completeHandoff('opaque-handle')).ok).toBe(false);
      expect(await preview.getConsentContext('opaque-handle')).toBeUndefined();
      expect((await preview.decideConsent('opaque-handle', 'approve')).ok).toBe(false);

      expect(challenge.ok).toBe(false);
      expect(paths).toEqual([
        '/api/auth/challenge',
        '/api/auth/handoff',
        '/api/consent/context',
        '/api/consent/decide',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('takes the security port from the real adapter — unavailable, refusing', async () => {
    const preview = createPreviewAccountAdapter();

    expect(preview.securityCapabilities).toEqual({
      passkeys: false,
      totp: false,
      'recovery-codes': false,
    });
    await expect(preview.listPasskeys()).rejects.toThrow('passkeys unavailable');
    await expect(preview.removePasskey('passkey-1')).resolves.toEqual({
      ok: false,
      reason: 'passkeys unavailable: no backend capability',
    });
  });

  it('takes data methods from the mock — deterministic fixtures on a full adapter', async () => {
    // Dữ liệu của preview là fixtures mock (tài khoản mẫu, email mẫu); mặt auth
    // và security trên cùng object này đến từ adapter thật — hai bất invariant
    // chạy cùng lúc trên một object duy nhất.
    const preview = createPreviewAccountAdapter();

    expect(preview.isPreview).toBe(true);
    const profile = await preview.getProfile();
    expect(profile.displayName).toBe('Nguyen Van A');
  });

  it('flags itself as preview data', () => {
    expect(createPreviewAccountAdapter().isPreview).toBe(true);
  });

  it('keeps mock writes in memory only — a fresh instance sees none of them', async () => {
    const first = createPreviewAccountAdapter();
    await first.updateProfile({ displayName: 'Ephemeral Name' });
    expect((await first.getProfile()).displayName).toBe('Ephemeral Name');

    const second = createPreviewAccountAdapter();
    expect((await second.getProfile()).displayName).toBe('Nguyen Van A');
  });

  it('does not touch the network for data reads even though auth is real', async () => {
    // Đọc dữ liệu của preview là fixtures cục bộ — một mock gọi endpoint thật
    // sẽ biến preview thành đường đọc/ghi dữ liệu ngoài ý muốn.
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        throw new Error('preview must not fetch');
      }),
    );
    try {
      const preview = createPreviewAccountAdapter();
      await preview.getProfile();
      await preview.listEmails();
      expect(requests).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
