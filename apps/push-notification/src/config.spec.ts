/**
 * Config fail-closed — sáu tham số SLA phải **ném** khi thiếu, và **không bao giờ** tự chọn.
 *
 * ⚠️ **Đây là test quan trọng nhất của cả service về mặt cấu hình.** Sáu tham số SLA là
 * *cam kết với bên ngoài*, không phải lựa chọn kỹ thuật: `idempotency_retention` quyết định
 * một retry của client còn được replay hay không, `caller_retry_window` và
 * `max_notification_ttl` quyết định một notification còn đáng gửi hay không. Một default tự
 * đặt ở đây là một SLA vô danh — và nó sẽ chạy trong production mà không ai biết.
 *
 * ⚠️ **Không có `it.skip` và không có "chỉ đoán".** Mỗi test dưới đây xoá **đúng một** biến
 * và khẳng định hai điều: `PushConfigError` ném ra, và `problems` chứa **đúng tên biến đó**.
 * Assertion thứ hai mới là thứ bắt được một "default thay vì ném".
 *
 * ⚠️ **Thông điệp lỗi không được chứa giá trị.** Mỗi biến ở đây mang một giá trị *độc đáo*
 * (`idempotency_retention_ms` chứa `1111111`, …). Với sáu giá trị khác nhau, nếu thông điệp
 * lỗi chứa giá trị thì test đỏ — đó là cách chứng minh "không log giá trị" thay vì tin vào
 * lời bình luận.
 *
 * Nguồn: `docs/applications/push-notification/03-operations.md` §11 (launch gate);
 * `02-requirements.md` FR-008.
 */

import { describe, expect, it } from 'vitest';

import {
  PushConfigError,
  resolvePushNotificationConfig,
} from '@ecoma-io/push-notification-application';

/**
 * Env **đầy đủ và hợp lệ** — mọi test dưới đây bắt đầu từ đây rồi xoá đúng một biến.
 *
 * ⚠️ Sáu giá trị SLA là hằng của **test**, không phải giá trị service: test cần một env hợp
 * lệ để chứng minh "xoá một biến thì ném", và việc service dùng giá trị nào ở production là
 * quyết định của service owner.
 *
 * ⚠️ Năm giá trị số **phải vừa độc đáo theo cặp vừa thoả ràng buộc coherence của FR-008**
 * (`idempotency_retention ≥ caller_retry_window`, `caller_retry_window ≤ max_notification_ttl`).
 * Env này không thoả thì `assertConfigCoherence` ném trước khi test kịp đo thứ nó muốn đo —
 * và một test đỏ vì lý do không liên quan là một test không còn kiểm tra điều nó tên.
 */
const COMPLETE_ENV: Record<string, string> = {
  /* Sáu SLA — fail closed. Năm số: đôi một khác nhau và đúng thứ tự ràng buộc. */
  IDEMPOTENCY_RETENTION_MS: '7000007',
  CALLER_RETRY_WINDOW_MS: '3000003',
  MAX_NOTIFICATION_TTL_MS: '5000005',
  PAYLOAD_DIGEST_ALGORITHM: 'none',
  OUTBOX_RECOVERY_SLA_MS: '1111111',
  DELIVERY_RECONCILIATION_AGE_MS: '2222222',
  /* Engineering — có default, không cần set. */
  /* Auth / keyring. */
  RUNTIME_API_EXPECTED_PRINCIPAL: 'svc.web-push-notification-job',
  RUNTIME_API_SHARED_SECRET: 'runtime-secret',
  ADMIN_API_TOKEN: 'admin-token',
  ADMIN_API_PRINCIPAL: 'backoffice',
  APPLICATION_API_TOKEN: 'application-token',
  APPLICATION_API_PRINCIPAL: 'ecoma-io',
  CREDENTIAL_KEY_VERSION: 'K1',
  CREDENTIAL_SERVING_VERSIONS: 'K1',
  /* Metadata. */
  ENVIRONMENT: 'test',
  LOG_LEVEL: 'error',
};

/**
 * Sáu tên biến SLA — liệt kê tường minh thay vì suy ra từ object.
 *
 * ⚠️ Mảng này là **spec của yêu cầu "fail closed"**: mỗi phần tử là một case bắt buộc có một
 * test riêng ngay bên dưới. Thêm một SLA mới vào `CONFIG_VARIABLE` mà quên thêm ở đây thì
 * `expect(MISSING).toHaveLength(6)` bên dưới đỏ — đó là cái giá của một danh sách viết tay.
 */
const SLA_VARIABLE_NAMES = [
  'IDEMPOTENCY_RETENTION_MS',
  'CALLER_RETRY_WINDOW_MS',
  'MAX_NOTIFICATION_TTL_MS',
  'PAYLOAD_DIGEST_ALGORITHM',
  'OUTBOX_RECOVERY_SLA_MS',
  'DELIVERY_RECONCILIATION_AGE_MS',
] as const;

/**
 * Bản sao của `COMPLETE_ENV` **không** có `variable`.
 *
 * ⚠️ **Vì sao dựng lại thay vì `delete env[variable]`.** `@typescript-eslint/no-dynamic-delete`
 * của repo cấm xoá key tính bằng biến, và đúng lý do: xoá key động khỏi một object dùng
 * chung là một thao tác trừng phạt kiểu `Partial<Record<...>>`, và người đọc phải tự suy ra
 * rằng object gốc không bị đụng. Ở đây mối đe dọa đó là **thật**: `COMPLETE_ENV` là hằng
 * module, và một `delete` chạy đúng hai lần sẽ biến mọi test sau đó thành xanh sai. Cách
 * này không thể alias — object mới có identity riêng, và object gốc không thể bị đụng.
 */
function envWithout(variable: string): Record<string, string> {
  return Object.fromEntries(Object.entries(COMPLETE_ENV).filter(([name]) => name !== variable));
}

describe('resolvePushNotificationConfig — fails closed on the six SLA parameters', () => {
  it('has exactly six SLA variables under test', () => {
    // ⚠️ Test bảo vệ chính **danh sách** này: nếu một SLA thứ bảy được thêm vào mã mà danh
    // sách ở đây không đổi, mọi test bên dưới vẫn xanh và service lại fail-open trên một tham
    // số mới. Assertion này biến "sáu" thành một bất biến có kiểm.
    expect(SLA_VARIABLE_NAMES).toHaveLength(6);
  });

  it('accepts a complete environment and returns every SLA value verbatim', () => {
    const config = resolvePushNotificationConfig({ ...COMPLETE_ENV });

    // ⚠️ Assert **từng giá trị** chứ không chỉ "không ném": một implementation tự chọn
    // default rồi vẫn không ném sẽ qua test "không ném" — nhưng nó đã sai. Truyền `7000007`
    // và đòi config trả `7000007` là cách bắt được default chen vào giữa.
    expect(config.sla).toEqual({
      idempotencyRetentionMs: 7000007,
      callerRetryWindowMs: 3000003,
      maxNotificationTtlMs: 5000005,
      payloadDigestAlgorithm: 'none',
      outboxRecoverySlaMs: 1111111,
      deliveryReconciliationAgeMs: 2222222,
    });
  });

  for (const variable of SLA_VARIABLE_NAMES) {
    it(`throws PushConfigError naming ${variable} when it is absent`, () => {
      let thrown: unknown;
      try {
        resolvePushNotificationConfig(envWithout(variable));
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PushConfigError);
      const error = thrown as PushConfigError;
      expect(error.problems).toContain(variable);
      // ⚠️ Chỉ **một** problem: nếu xoá `IDEMPOTENCY_RETENTION_MS` mà `problems` chứa hai tên
      // thì `resolveSla` đang gom nhầm — và một log lỗi liệt kê tên không liên quan làm operator
      // sửa nhầm biến.
      expect(error.problems).toHaveLength(1);
    });
  }

  for (const variable of SLA_VARIABLE_NAMES) {
    it(`keeps the other five SLA names out of the error when only ${variable} is missing`, () => {
      expect(() => resolvePushNotificationConfig(envWithout(variable))).toThrowError(
        // ⚠️ Cờ `u` bắt buộc của repo: không có nó, một regex gặp một "từ" tiếng Việt không
        // dấu đúng là sẽ khớp sai — `[\s\S]` không cần nó nhưng toàn bộ mẫu ở đây được viết
        // theo cùng quy tắc để không có hai kiểu regex trong cùng một file.
        new RegExp(`Thiếu hoặc sai cấu hình bắt buộc[\\s\\S]*${variable}`, 'u'),
      );
      // ⚠️ Cùng lúc, **không** tên biến khác của SLA nào xuất hiện trong thông điệp. Đây là
      // kiểm bổ sung cho `toHaveLength(1)` ở trên nhưng gắn với **nội dung** thông điệp, nơi
      // người đọc log thật sự nhìn thấy.
      //
      // ⚠️ `expect` **không** nằm trong vòng lặp có `continue` (`vitest/no-conditional-expect`:
      // một `expect` trong nhánh không chạy là một assertion không tồn tại). `slaNamesOtherThan`
      // lọc **tên của chính biến đang kiểm** ra ngoài — tên đó **phải** xuất hiện, nó là thứ
      // test liên kề khẳng định — rồi **một** assertion đẳng kỳ lấy danh sách rỗng. Danh sách
      // rỗng nêu đích danh tên bị lộ khi đỏ; `expect(cond).toBe(false)` trong vòng lặp thì không.
      expect(slaNamesOtherThan(missingOnlyMessage(variable), variable)).toEqual([]);
    });
  }

  it('never puts the value of a missing SLA into the error message', () => {
    // ⚠️ Sáu giá trị trong `COMPLETE_ENV` là **độc đáo theo cặp**. Thông điệp lỗi của một cấu
    // hình thiếu phải **không** chứa bất kỳ giá trị nào trong sáu giá trị đó — vì thông điệp đó
    // đi vào log Worker, nơi mọi người đọc log đều thấy.
    let message = '';
    try {
      resolvePushNotificationConfig(envWithout('IDEMPOTENCY_RETENTION_MS'));
    } catch (error: unknown) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    // ⚠️ Chỉ kiểm **sáu** giá trị SLA — token auth là secret và chúng cũng không được lộ, nhưng
    // chúng không phải thứ test này điều tra (và `requireSecret` đã có test riêng). Lọc ra danh
    // sách trước rồi assert **một lần**: `expect` trong `if` ở đây là assertion có điều kiện,
    // và với sáu phần tử thì một `if` sai là thiếu hẳn một assertion.
    expect(slaValuesLeakingInto(message)).toEqual([]);
  });

  it('reports every missing SLA at once so an operator can fix them in one pass', () => {
    const env: Record<string, string> = {};
    for (const name of Object.keys(COMPLETE_ENV)) {
      if (SLA_VARIABLE_NAMES.includes(name as (typeof SLA_VARIABLE_NAMES)[number])) {
        continue;
      }
      env[name] = COMPLETE_ENV[name] ?? '';
    }

    let thrown: unknown;
    try {
      resolvePushNotificationConfig(env);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    // ⚠️ `PushConfigError.problems` là **danh sách** và mọi phần tử phải là tên biến. Đây là
    // hợp đồng mà `problems.join('; ')` dựng vào message dựa vào — nếu nó chỉ có một tên thì
    // mỗi lần deploy lại phải chạy sáu vòng sửa lỗi tuần tự.
    //
    // ⚠️ Thứ tự **cố ý** là thứ tự `resolveSla` đẩy vào, không phải thứ tự khai ở
    // `SLA_VARIABLE_NAMES`: năm tham số millis được đọc theo thứ tự rồi
    // `payload_digest_algorithm` được kiểm **sau** vì nó là *tên thuật toán*, không phải số.
    // Assert thứ tự chứ không chỉ tập hợp là để một refactor đổi thứ tự hiển thị trong log
    // cũng phải là một thay đổi có chủ đích.
    expect((thrown as PushConfigError).problems).toEqual([
      'IDEMPOTENCY_RETENTION_MS',
      'CALLER_RETRY_WINDOW_MS',
      'MAX_NOTIFICATION_TTL_MS',
      'OUTBOX_RECOVERY_SLA_MS',
      'DELIVERY_RECONCILIATION_AGE_MS',
      'PAYLOAD_DIGEST_ALGORITHM',
    ]);
  });

  it('rejects a non-numeric SLA value instead of falling back to a default', () => {
    // ⚠️ `readRequiredMilliseconds` kiểm **hình dạng**, không chỉ sự hiện diện. Một biến có
    // mặt nhưng rác là "chưa có quyết định" theo đúng lý do fail closed.
    const env = { ...COMPLETE_ENV, MAX_NOTIFICATION_TTL_MS: 'soon' };

    let thrown: unknown;
    try {
      resolvePushNotificationConfig(env);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems).toEqual(['MAX_NOTIFICATION_TTL_MS']);
  });

  it('rejects an unconfigured payload digest algorithm rather than inventing one', () => {
    // ⚠️ `payload_digest_algorithm` là open item: worker đối chiếu digest theo contract, nên
    // một digest bịa khiến worker từ chối những response vốn hợp lệ — tệ hơn nhiều so với
    // không có digest. `none` là giá trị hợp lệ **duy nhất** ở v1.
    const env = { ...COMPLETE_ENV, PAYLOAD_DIGEST_ALGORITHM: 'sha-256' };

    let thrown: unknown;
    try {
      resolvePushNotificationConfig(env);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems).toEqual(['PAYLOAD_DIGEST_ALGORITHM']);
  });

  it('rejects a credential keyring whose current version is not served', () => {
    // ⚠️ `CREDENTIAL_SERVING_VERSIONS` phải **chứa** `CREDENTIAL_KEY_VERSION`: ghi bằng `K2`
    // trong khi `K2` không được phục vụ nghĩa là mọi credential mới ghi ra đều không đọc
    // được, và lỗi đó chỉ lộ ra ở claim — tức lúc đã gửi notification thật (§7.3).
    const env = {
      ...COMPLETE_ENV,
      CREDENTIAL_KEY_VERSION: 'K2',
      CREDENTIAL_SERVING_VERSIONS: 'K1',
    };

    let thrown: unknown;
    try {
      resolvePushNotificationConfig(env);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems).toEqual(['CREDENTIAL_SERVING_VERSIONS']);
  });

  it('rejects an idempotency retention shorter than the caller retry window', () => {
    // ⚠️ Đây là **ràng buộc của tài liệu**, không phải phán đoán: FR-008 nói
    // `idempotency_retention` MUST ≥ `caller_retry_window`. Hai giá trị đều là quyết định của
    // owner; đặt retention ngắn hơn retry window là một cam kết tự mâu thuẫn, và service
    // phải **báo** chứ không nên "làm cho nó chạy được".
    const env = {
      ...COMPLETE_ENV,
      IDEMPOTENCY_RETENTION_MS: '60000',
      CALLER_RETRY_WINDOW_MS: '120000',
      MAX_NOTIFICATION_TTL_MS: '3333333',
    };

    let thrown: unknown;
    try {
      resolvePushNotificationConfig(env);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems.join(' ')).toContain('IDEMPOTENCY_RETENTION_MS');
  });

  it('accepts an idempotency retention exactly equal to the caller retry window', () => {
    // ⚠️ Ràng buộc là `≥`, **không** phải `>`. Một test chỉ khẳng định "bằng thì ném" sẽ làm
    // một cấu hình hợp lệ bị từ chối — và đó là lỗi của service chứ không phải của cấu hình.
    const config = resolvePushNotificationConfig({
      ...COMPLETE_ENV,
      IDEMPOTENCY_RETENTION_MS: '120000',
      CALLER_RETRY_WINDOW_MS: '120000',
    });
    expect(config.sla.idempotencyRetentionMs).toBe(120000);
    expect(config.sla.callerRetryWindowMs).toBe(120000);
  });

  it('rejects a caller retry window longer than the notification TTL', () => {
    const env = {
      ...COMPLETE_ENV,
      CALLER_RETRY_WINDOW_MS: '99999999',
      MAX_NOTIFICATION_TTL_MS: '3333333',
      IDEMPOTENCY_RETENTION_MS: '999999990',
    };

    let thrown: unknown;
    try {
      resolvePushNotificationConfig(env);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems.join(' ')).toContain('CALLER_RETRY_WINDOW_MS');
  });
});

/**
 * Tên biến SLA nào **khác** `excluded` xuất hiện trong `message` — danh sách rỗng nghĩa là sạch.
 *
 * ⚠️ `excluded` là tên **được phép** xuất hiện: khi biến đó thiếu thì thông điệp phải nêu nó,
 * và đó là điều test liên kề khẳng định. Ở đây chỉ những tên **không liên quan** mới bị coi là
 * rò rỉ — một log lỗi liệt kê tên không liên quan làm operator sửa nhầm biến.
 *
 * ⚠️ Lọc bằng `filter` rồi assert **một lần**, thay vì `expect` trong `if`: `Array#filter` trả
 * danh sách, nên một `toEqual([])` **nêu đích danh** tên bị lộ khi đỏ — thứ mà
 * `expect(cond).toBe(false)` trong vòng lặp không làm được.
 */
function slaNamesOtherThan(message: string, excluded: string): readonly string[] {
  return SLA_VARIABLE_NAMES.filter((name) => name !== excluded && message.includes(name));
}

/**
 * Giá trị SLA nào xuất hiện trong `message` — danh sách rỗng nghĩa là sạch.
 *
 * ⚠️ Lọc theo **tên biến**, không theo "mọi giá trị trong `COMPLETE_ENV`": token auth cũng là
 * giá trị trong đó, và đưa chúng vào phạm vi kiểm tra sẽ khiến test này đòi thứ không thuộc
 * đề bài của nó (việc đó thuộc `requireSecret`). `Set` vì `COMPLETE_ENV` có thể dùng chung
 * một giá trị cho hai biến — và một giá trị lộ thì phải được báo đúng một lần.
 */
function slaValuesLeakingInto(message: string): readonly string[] {
  const slaValues = SLA_VARIABLE_NAMES.map((name) => COMPLETE_ENV[name]);
  return [...new Set(slaValues)].filter((value) => value !== undefined && message.includes(value));
}

/** Thông điệp lỗi khi thiếu **đúng một** biến `variable`. */
function missingOnlyMessage(variable: string): string {
  try {
    resolvePushNotificationConfig(envWithout(variable));
  } catch (error: unknown) {
    return (error as Error).message;
  }
  throw new Error(`resolvePushNotificationConfig không ném khi thiếu ${variable}.`);
}
