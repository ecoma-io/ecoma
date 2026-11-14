/**
 * Test cho ranh giới cấu hình BFF — `server/utils/broker-config.ts`.
 *
 * Đây là chốt fail-closed của dashboard: mọi route `/api/broker/**` và `/ready`
 * đi qua `pactBrokerBffConfig()`, và `null` của nó là tín hiệu 503. Một lỗ
 * hổng ở đây (chấp nhận URL có path, mis-read shape) là lỗ hổng của cả
 * dashboard — nên test này không mô tả "hành vi đẹp" mà ghim từng nhánh từ
 * chối.
 *
 * ⚠️ Không còn khoá token (ADR-0031 §5): machine token của BFF bị **retire
 * hoàn toàn**, nên config chỉ còn base URL. Test ghim luôn rằng accessor
 * **không** đọc bất kỳ khoá token nào — một khoá token còn sót trong
 * runtimeConfig là credential thừa phải revoke sau này (đúng lý do ADR-0031
 * §5 nêu).
 */
import { describe, expect, it } from 'vitest';

import { PACT_BROKER_API_BASE_URL_KEY, pactBrokerBffConfig } from '../server/utils/broker-config';

/** Shape đầy đủ, hợp lệ — điểm khởi phát của mọi test biến thể. */
const VALID = {
  pactBrokerApiBaseUrl: 'https://stg-ecoma-pact-broker-api.workers.dev',
};

describe('pactBrokerBffConfig', () => {
  it('accepts an absolute http(s) origin', () => {
    expect(pactBrokerBffConfig(VALID)).toEqual({
      baseUrl: 'https://stg-ecoma-pact-broker-api.workers.dev',
    });
  });

  it('exposes no token in the resolved config', () => {
    // Machine token của BFF đã bị retire (ADR-0031 §5) — config trả về không
    // được chứa field credential nào.
    expect(Object.keys(pactBrokerBffConfig(VALID) ?? {}).toSorted()).toEqual(['baseUrl']);
  });

  it('ignores a leftover token key instead of resolving it', () => {
    // Một khoá token còn sót trong runtimeConfig không được biến thành
    // credential của BFF — accessor chỉ đọc base URL.
    const config = pactBrokerBffConfig({ ...VALID, pactBrokerApiToken: 'stale-token' });
    expect(config).toEqual({ baseUrl: VALID.pactBrokerApiBaseUrl });
    expect(JSON.stringify(config)).not.toContain('stale-token');
  });

  it('normalizes trailing casing of the scheme and keeps the origin only', () => {
    // URL parse lower-cases scheme/host; accessor trả origin đã chuẩn hoá, nên
    // caller không thể dựng URL sai từ `baseUrl`.
    const config = pactBrokerBffConfig({
      ...VALID,
      pactBrokerApiBaseUrl: 'HTTPS://BROKER.API.TEST:8443/',
    });
    expect(config?.baseUrl).toBe('https://broker.api.test:8443');
  });

  it('returns null when the base URL key is missing', () => {
    // Spread + ghi đè `undefined` thay vì `delete` — cùng hiệu ứng với key vắng
    // mặt mà không dùng xoá khoá động (bị lint cấm).
    expect(pactBrokerBffConfig({ ...VALID, [PACT_BROKER_API_BASE_URL_KEY]: undefined })).toBeNull();
  });

  it('returns null on empty-string values — the build-time defaults', () => {
    // Default trong nuxt.config.ts là chuỗi rỗng: "chưa cấu hình" phải thành
    // 503, không phải "chạy được với base rỗng".
    expect(pactBrokerBffConfig({ ...VALID, pactBrokerApiBaseUrl: '' })).toBeNull();
  });

  it('returns null when a value has the wrong type', () => {
    // Secret nối vào runtime config ở request trên Workers — shape sai là
    // trạng thái thật, không phải giả định; accessor không được ném.
    expect(pactBrokerBffConfig({ ...VALID, pactBrokerApiBaseUrl: 123 })).toBeNull();
    expect(pactBrokerBffConfig(undefined)).toBeNull();
    expect(pactBrokerBffConfig(null)).toBeNull();
  });

  it('rejects base URLs that are not bare origins', () => {
    // Path/query/hash bị từ chối: caller tự ghép path, URL lẫn path thừa sẽ
    // tạo endpoint kép (`/matrix/pacticipants`...). Parse bằng `new URL` —
    // kiểm bằng prefix chuỗi bị qua mặt (scheme hoa, userinfo, encoding).
    const cases = [
      'https://broker.api.test/api',
      'https://broker.api.test/?x=1',
      'https://broker.api.test/#frag',
      'https://user:pass@broker.api.test',
      'ftp://broker.api.test',
      'javascript:alert(1)',
      '//broker.api.test',
      'broker.api.test',
      'https://',
    ];
    for (const url of cases) {
      expect(
        pactBrokerBffConfig({ ...VALID, pactBrokerApiBaseUrl: url }),
        `url: ${url}`,
      ).toBeNull();
    }
  });

  it('rejects non-string URL shapes without throwing', () => {
    expect(pactBrokerBffConfig({ ...VALID, pactBrokerApiBaseUrl: 'not a url' })).toBeNull();
  });

  it('does not reflect the rejected URL in its error output', () => {
    // accessor chỉ trả `null` — không có chuỗi chẩn đoán chứa URL bị từ chối
    // (URL có thể mang credential khi caller dựng sai).
    const result = pactBrokerBffConfig({
      ...VALID,
      pactBrokerApiBaseUrl: 'https://user:secret@evil.test',
    });
    expect(result).toBeNull();
  });
});
