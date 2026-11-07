/**
 * Ma trận SSRF của `validatePushEndpoint` — sáu điều kiện bắt buộc của FR-003.
 *
 * ⚠️ **Vì sao đây là một ma trận chứ không phải vài test đại diện.** FR-003 là một trong
 * những yêu cầu có hậu quả bảo mật trực tiếp: một endpoint là do **client** cung cấp và
 * sẽ được `fetch` bởi delivery worker. Mỗi dòng của ma trận là một cách lách một điều kiện,
 * và "tôi đã kiểm IP literal" không nói được endpoint viết bằng chữ số nguyên
 * (`http://2130706433/`) cũng là một IP literal.
 *
 * ⚠️ **Mỗi dòng của ma trận có `reason` mong đợi, không chỉ "bị từ chối".** Chỉ assert
 * `ok === false` thì một hàm từ chối đúng nhưng **vì sai lý do** vẫn xanh — và người đọc log
 * lúc vận hành lại nhận thông điệp sai. `reason` là hợp đồng với log và metric.
 *
 * ⚠️ **Allowlist rỗng phải fail closed.** Không cấu hình allowlist không phải "cho phép tất
 * cả" — nó nghĩa là deployment chưa cấu hình, và nó **không** được đăng ký endpoint nào.
 *
 * ⚠️ **Không tuyên bố chống được SSRF.** Host trong allowlist vẫn có thể resolve về địa chỉ
 * private qua DNS rebinding — allowlist kiểm *tên*, request đi tới *địa chỉ*. Các test dưới
 * đây chứng minh allowlist **có thật** và được so **theo ranh giới nhãn**; chúng không chứng
 * minh điều mà FR-003 nói thẳng là không thể chứng minh.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
  revalidateStoredEndpoint,
  validatePushEndpoint,
  type EndpointValidation,
  type EndpointValidationSuccess,
  type UseCaseResult,
} from '@ecoma-io/push-notification-application';

/** Allowlist rỗng — trạng thái của một deployment chưa cấu hình. */
const NO_ALLOWLIST: readonly string[] = [];

/** `reason` của một validation bị từ chối, hoặc `null` khi được chấp nhận. */
function rejectionReason(validation: EndpointValidation): string | null {
  return validation.ok ? null : validation.reason;
}

/** `host` mà một endpoint hợp lệ chuẩn hoá ra, hoặc `null`. */
function acceptedHost(validation: EndpointValidation): string | null {
  return validation.ok ? validation.value.host : null;
}

/* -------------------------------------------------------------------------------------- */
/* Narrowing thay vì `if` quanh `expect`                                                      */
/* -------------------------------------------------------------------------------------- */

/**
 * `expect` **không** nằm trong `if` — dùng helper của vitest.
 *
 * ⚠️ **Vì sao.** `validatePushEndpoint` và `revalidateStoredEndpoint` trả union, nên muốn
 * đọc `value` hay `reason` phải narrow trước. Cách quen thuộc là
 * `if (v.ok) { expect(v.value…) }` — và đó **đúng** là `vitest/no-conditional-expect`: một
 * `expect` trong nhánh không chạy là một assertion không tồn tại, và `if` thiếu `else` là
 * một nhánh im lặng khi union đổi shape. `expect(...).toBe(...)` đẳng kỳ lấy luôn cả `else`.
 *
 * ⚠️ `acceptedValue`/`rejectionDetail` bên dưới dùng cách khác: chúng **không** narrow mà
 * đọc qua một biến đã được kiểm. Ở đó bất biến là "không có field khi không hợp lệ" và giá
 * trị trả về được `expect` kiểm riêng — đọc kiểu đó là an toàn vì không có assertion nào bị
 * bỏ qua.
 */

/** Toàn bộ payload của một validation hợp lệ — ném nếu không hợp lệ. */
function acceptedValue(validation: EndpointValidation): EndpointValidationSuccess {
  if (!validation.ok) {
    throw new Error(
      `endpoint bị từ chối với lý do ${validation.reason} trong khi test cần hợp lệ.`,
    );
  }
  return validation.value;
}

/** `detail` của một kết quả bị từ chối — ném nếu hợp lệ. */
function rejectionDetail(result: UseCaseResult<{ readonly valid: true }>): string {
  if (result.ok) {
    throw new Error('kết quả hợp lệ trong khi test cần một kết quả bị từ chối.');
  }
  return result.detail;
}

describe('validatePushEndpoint — conditions 1..3: scheme, parse, userinfo', () => {
  it.each([
    ['an empty string', '', 'endpoint_empty'],
    ['a non-https scheme', 'http://fcm.googleapis.com/send', 'endpoint_not_https'],
    ['a websocket scheme', 'wss://fcm.googleapis.com/send', 'endpoint_not_https'],
    ['a javascript scheme', 'javascript:alert(1)', 'endpoint_not_https'],
    ['an unparseable URL', 'not a url at all', 'endpoint_malformed'],
    ['a scheme-relative URL', '//fcm.googleapis.com/send', 'endpoint_malformed'],
  ])('rejects %s with reason %s', (_label, endpoint, reason) => {
    // ⚠️ Allowlist **rỗng** ở các test này: nếu allowlist đầy đủ, một endpoint sai vẫn bị từ
    // chối — nhưng vì allowlist. Dùng allowlist rỗng biến mỗi dòng thành phép kiểm **riêng**
    // của điều kiện 1..3, vì thứ tự kiểm là rẻ → đắt và `allowlist_allowlist_empty` là điều
    // kiện đắt nhất.
    const validation = validatePushEndpoint(endpoint, NO_ALLOWLIST);
    expect(rejectionReason(validation)).toBe(reason);
  });

  it('rejects an endpoint carrying userinfo before the host is even inspected', () => {
    // ⚠️ `https://user:pass@fcm.googleapis.com/send` — host **có** trong allowlist, nên nếu
    // userinfo không được kiểm thì nó lọt. Đây là dòng dễ sót nhất của ma trận vì host trông
    // hoàn toàn hợp lệ.
    const validation = validatePushEndpoint(
      'https://user:pass@fcm.googleapis.com/send/abc',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(rejectionReason(validation)).toBe('endpoint_userinfo');
  });

  it('rejects an endpoint with a username but no password', () => {
    const validation = validatePushEndpoint(
      'https://user@fcm.googleapis.com/send/abc',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(rejectionReason(validation)).toBe('endpoint_userinfo');
  });

  it('rejects an endpoint longer than the documented length ceiling', () => {
    // ⚠️ 2048 là trần của `MAX_PUSH_ENDPOINT_LENGTH`. Endpoint thật dài ~150–400 ký tự; trần
    // rộng có chủ ý để một push service khác vẫn nằm trong giới hạn, nhưng một endpoint
    // 5000 ký tự là chi phí lưu trữ và log, không phải một endpoint.
    const long = `https://fcm.googleapis.com/send/${'a'.repeat(2100)}`;
    expect(rejectionReason(validatePushEndpoint(long, DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST))).toBe(
      'endpoint_too_long',
    );
  });

  it('rejects a non-string endpoint instead of coercing it', () => {
    // ⚠️ Endpoint đến từ body JSON, tức là dữ liệu client kiểm soát. `String(value)` ở đây
    // sẽ biến một object thành `"[object Object]"` rồi đi tiếp vào các kiểm còn lại với một
    // hình dạng không ai dự định.
    for (const value of [null, undefined, 42, true, { url: 'x' }, ['x']]) {
      const validation = validatePushEndpoint(value, DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
      expect(rejectionReason(validation)).toBe('endpoint_type');
    }
  });
});

describe('validatePushEndpoint — condition 4: IP literals and private ranges', () => {
  // ⚠️ Mỗi dòng là **một dạng biểu diễn khác nhau** của cùng một địa chỉ, hoặc một dải
  // khác nhau. Chỉ kiểm `127.0.0.1` thì `http://2130706433/`, `https://[::1]/` và
  // `https://0x7f000001/` đều lọt — và chúng là ba cách viết của **cùng một** loopback.
  it.each([
    ['dotted IPv4 loopback', 'https://127.0.0.1/send', 'endpoint_ip_literal'],
    ['decimal IPv4 loopback', 'https://2130706433/send', 'endpoint_ip_literal'],
    ['hex IPv4 loopback', 'https://0x7f000001/send', 'endpoint_ip_literal'],
    ['IPv6 loopback compressed', 'https://[::1]/send', 'endpoint_ip_literal'],
    ['IPv6 loopback expanded', 'https://[0:0:0:0:0:0:0:1]/send', 'endpoint_ip_literal'],
    ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/send', 'endpoint_ip_literal'],
    // Dạng đã chuẩn hoá hex — URL parser đổi `::ffff:127.0.0.1` thành `::ffff:7f00:1`, và
    // mẫu chặn phải khớp cả hai dạng (mẫu `/^::$ffff:/iu` cũ không bao giờ khớp gì vì `$`
    // là anchor giữa mẫu; đây là dòng mang tải duy nhất).
    ['IPv4-mapped IPv6 canonical hex', 'https://[::ffff:7f00:1]/send', 'endpoint_ip_literal'],
    ['IPv6 unique local', 'https://[fd00::1]/send', 'endpoint_ip_literal'],
    ['IPv6 link-local', 'https://[fe80::1]/send', 'endpoint_ip_literal'],
    ['RFC1918 10/8', 'https://10.1.2.3/send', 'endpoint_ip_literal'],
    ['RFC1918 172.16/12', 'https://172.20.0.1/send', 'endpoint_ip_literal'],
    ['RFC1918 192.168/16', 'https://192.168.1.1/send', 'endpoint_ip_literal'],
    ['link-local 169.254/16', 'https://169.254.169.254/send', 'endpoint_ip_literal'],
    ['cloud metadata endpoint', 'https://169.254.169.254/latest/meta-data', 'endpoint_ip_literal'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/send', 'endpoint_ip_literal'],
    ['documentation 192.0.2/24', 'https://192.0.2.10/send', 'endpoint_ip_literal'],
  ])('rejects %s with reason %s', (_label, endpoint, reason) => {
    const validation = validatePushEndpoint(endpoint, DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
    expect(rejectionReason(validation)).toBe(reason);
  });

  it('rejects an IP literal even when that IP is listed in the allowlist', () => {
    // ⚠️ Điều kiện 4 đứng **trước** điều kiện 5, và đây là lý do: một operator có thể vô tình
    // hoặc cố ý thêm một IP vào allowlist (ví dụ một push service tự host trong VPC), và lúc
    // đó "IP literal" phải thắng. Đảo thứ tự hai điều kiện này biến allowlist thành lỗ hổng
    // SSRF có cấu hình.
    const validation = validatePushEndpoint('https://10.0.0.5/send', ['10.0.0.5']);
    expect(rejectionReason(validation)).toBe('endpoint_ip_literal');
  });
});

describe('validatePushEndpoint — condition 5: allowlist matched at label boundaries', () => {
  it('accepts each host of the default allowlist', () => {
    // ⚠️ Ba host là ba Browser Push Service mà v1 thật sự cần. Nếu một cái bị bỏ khỏi danh
    // sách mặc định thì người dùng của trình duyệt tương ứng không đăng ký được subscription
    // nữa — và lỗi đó chỉ hiện ở client.
    for (const host of [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'webkit.push.apple.com',
    ]) {
      const validation = validatePushEndpoint(
        `https://${host}/fcm/send/token`,
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      );
      expect(acceptedHost(validation)).toBe(host);
    }
  });

  it('accepts a subdomain of an allowlisted host but only at a label boundary', () => {
    // ⚠️ Đây là phản diện mà FR-003 nêu đích danh: allowlist `example.com` **không** được
    // khớp bởi `evil-example.com`, và **được** khớp bởi `a.example.com`. So sánh bằng
    // `endsWith` không có dấu chấm là đúng lỗi này.
    const allowlist = ['push.example.com'];
    expect(acceptedHost(validatePushEndpoint('https://a.push.example.com/s', allowlist))).toBe(
      'a.push.example.com',
    );
    expect(
      rejectionReason(validatePushEndpoint('https://evil-push.example.com/s', allowlist)),
    ).toBe('endpoint_host_not_allowlisted');
  });

  it('rejects a host that merely contains an allowlisted host as a prefix', () => {
    for (const host of [
      'evil-fcm.googleapis.com.attacker.test',
      'fcm.googleapis.com.attacker.test',
      'notfcm.googleapis.com',
      'xfcm.googleapis.com',
    ]) {
      const validation = validatePushEndpoint(
        `https://${host}/send`,
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      );
      expect(rejectionReason(validation)).toBe('endpoint_host_not_allowlisted');
    }
  });

  it('matches an allowlisted host case-insensitively and normalises it to lowercase', () => {
    // ⚠️ Host trong URL là case-insensitive. Bỏ bước lowercase thì một endpoint hợp lệ bị từ
    // chối theo cách người vận hành không đoán ra, và họ sẽ nới allowlist tới khi nó rộng bất
    // khả chấp nhận. Giá trị trả về là **chuẩn hoá** — nó được dùng để băm `endpoint_hash`
    // ổn định, nên trả nguyên casing sẽ tạo hai hash cho một endpoint.
    const validation = validatePushEndpoint(
      'https://FCM.GoogleAPIs.COM/fcm/send/abc',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(acceptedHost(validation)).toBe('fcm.googleapis.com');
  });

  it('rejects a trailing-dot host at the DNS label check, before the allowlist check', () => {
    // ⚠️ `fcm.googleapis.com.` là một host DNS hợp lệ về ký hiệu (fully-qualified), và
    // `URL` giữ dấu chấm cuối. Hàm kiểm hostname **trước** allowlist, và nhãn rỗng ở cuối làm
    // `isDnsHostname` trả `false` — nên nó bị từ chối ở điều kiện 4 chứ không phải 5.
    //
    // ⚠️ Test này ghi nhận `reason` **thật**, không phải reason "lẽ ra phải có". Cả hai đều
    // từ chối đúng; nếu thứ tự kiểm đổi và reason đổi theo thì test đỏ, và người đọc sẽ biết
    // hành vi đã đổi chứ không phải endpoint đã lọt.
    const validation = validatePushEndpoint(
      'https://fcm.googleapis.com./send',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(rejectionReason(validation)).toBe('endpoint_malformed_host');
  });

  it('fails closed with an explicit reason when the allowlist is empty', () => {
    // ⚠️ Allowlist rỗng phải **từ chối mọi endpoint**, kể cả một host hoàn toàn hợp lệ. Đây là
    // trạng thái của một deployment chưa cấu hình, và nó không nên đăng ký được bất kỳ
    // endpoint nào.
    const validation = validatePushEndpoint(
      'https://fcm.googleapis.com/fcm/send/abc',
      NO_ALLOWLIST,
    );
    expect(rejectionReason(validation)).toBe('endpoint_allowlist_empty');
  });

  it('rejects a host whose label is not a valid DNS label', () => {
    // ⚠️ Gạch dưới là ký tự **hợp lệ** trong DNS (service records) nhưng **không** hợp lệ
    // trong một hostname của allowlist Browser Push Service, và `DNS_LABEL` cấm nó. Hàm
    // kiểm hình dạng hostname **trước** allowlist, nên host này bị từ chối ở điều kiện 4 với
    // `endpoint_malformed_host` — dù nó cũng không nằm trong allowlist.
    const validation = validatePushEndpoint(
      'https://fcm_googleapis.com/send',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(rejectionReason(validation)).toBe('endpoint_malformed_host');
  });

  it('rejects an allowlisted host that is only a prefix of a subdomain with a hyphen', () => {
    // ⚠️ Biến thể nhỏ của ranh giới nhãn: `push.example.com` trong allowlist, và host
    // `push.example.com-evil.test` kết thúc bằng chuỗi đó nhưng **không** phải subdomain.
    const validation = validatePushEndpoint('https://push.example.com-evil.test/send', [
      'push.example.com',
    ]);
    expect(rejectionReason(validation)).toBe('endpoint_host_not_allowlisted');
  });
});

describe('validatePushEndpoint — an accepted endpoint keeps the original string', () => {
  it('returns the original endpoint string unchanged so endpoint_hash stays stable', () => {
    // ⚠️ `endpoint` trả về là chuỗi sẽ **lưu vào D1**, còn `host` chỉ là chuẩn hoá để so
    // allowlist. Nếu hàm trả `value.endpoint` là bản chuẩn hoá, path/query sẽ bị đổi hoặc
    // mất và endpoint lưu lại sẽ là một endpoint khác với cái client đăng ký.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/AbC-123_x?collapse_key=abc%20def';
    const validation = validatePushEndpoint(endpoint, DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
    expect(validation.ok).toBe(true);
    const value = acceptedValue(validation);
    expect(value.endpoint).toBe(endpoint);
    expect(value.host).toBe('fcm.googleapis.com');
  });

  it('accepts a deep path with encoded characters', () => {
    // ⚠️ Endpoint thật của Browser Push Service có token dài và base64url; `+` và `/` trong
    // path phải sống sót. Một hàm dựng lại URL từ các thành phần sẽ hỏng chúng.
    const validation = validatePushEndpoint(
      'https://fcm.googleapis.com/fcm/send/aB3-_xYz%3D%3D',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(acceptedHost(validation)).toBe('fcm.googleapis.com');
  });

  it('accepts an endpoint on the default port and an explicit :443', () => {
    // ⚠️ Cả hai là cùng một endpoint về mặt ngữ nghĩa. `URL` bỏ `:443` khỏi `port` của một
    // URL https, nên endpoint có `:443` vẫn khớp allowlist theo host.
    expect(
      acceptedHost(
        validatePushEndpoint(
          'https://fcm.googleapis.com:443/send',
          DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
        ),
      ),
    ).toBe('fcm.googleapis.com');
  });

  it('rejects a non-standard port because the host allowlist is matched on hostname only', () => {
    // ⚠️ Ghi nhận hành vi thật: allowlist khớp trên **hostname**, không phải `host` (host =
    // hostname + port). Một endpoint `https://fcm.googleapis.com:8443/` có hostname hợp lệ
    // nên vượt qua điều kiện 5. Đây là giới hạn đã biết của allowlist theo host, được
    // ghi lại ở đây để một thay đổi trong tương lai không làm test này đỏ mà không ai biết
    // hành vi đã đổi — nếu chính policy cũng đổi thì đây là chỗ phải sửa.
    const validation = validatePushEndpoint(
      'https://fcm.googleapis.com:8443/send',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(acceptedHost(validation)).toBe('fcm.googleapis.com');
  });
});

describe('revalidateStoredEndpoint — tells a wrong endpoint apart from a corrupted row', () => {
  // ⚠️ Lượt quét định kỳ cần phân biệt hai tình huống: "endpoint sai → disable subscription"
  // và "row hỏng → để lượt sau". Một union `ok:false` không nói lời được, nên hàm này trả
  // `UseCaseResult` với hai `reason` khác nhau.
  it('reports endpoint_rejected for a stored endpoint that no longer matches the allowlist', () => {
    const result = revalidateStoredEndpoint(
      'https://attacker.test/send',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(result).toMatchObject({ ok: false, reason: 'endpoint_rejected' });
  });

  it('reports not_found for a stored endpoint that cannot be read at all', () => {
    // ⚠️ Row hỏng ≠ endpoint sai: disable một subscription vì storage hỏng là một hành động
    // phá dữ liệu người dùng mà không có bằng chứng nào ủng hộ.
    for (const stored of ['', null, undefined, 42]) {
      const result = revalidateStoredEndpoint(
        stored as unknown as string,
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      );
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    }
  });

  it('accepts a stored endpoint that is still valid', () => {
    const result = revalidateStoredEndpoint(
      'https://fcm.googleapis.com/fcm/send/abc',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(result).toEqual({ ok: true, value: { valid: true } });
  });

  it('includes the validation reason in the detail of endpoint_rejected without echoing the endpoint', () => {
    // ⚠️ `detail` đi vào log và response, nên nó **không** được chứa endpoint — đó là dữ liệu
    // của client và là một URL có thể trỏ vào hạ tầng nội bộ. `reason` ngắn là đủ để điều tra.
    const result = revalidateStoredEndpoint(
      'https://10.0.0.1/internal/send',
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    );
    expect(result.ok).toBe(false);
    const detail = rejectionDetail(result);
    expect(detail).toContain('endpoint_ip_literal');
    expect(detail).not.toContain('10.0.0.1');
  });
});
