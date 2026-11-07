/**
 * Adapter `oidc-provider` → `db-auth` (bảng `auth.oidc_state`, migration `0013`).
 *
 * ⚠️ **Bản chép của migration.** Giống `authorization-code-cas.ts` với `0004`: schema là
 * nơi khai ràng buộc, file này là nơi dùng schema. Mỗi câu SQL ở đây phải có câu tương
 * ứng đọc được trong `0013_oidc_provider_state.sql` — lệch tên cột chỉ lộ khi chạy với
 * schema thật, nên parity test (adapter.spec.ts, cùng thư mục) ghép hai bản khai
 * bằng text và ghép GRANTABLE_KINDS với CHECK allowlist của 0013.
 *
 * Hợp đồng đầy đủ của adapter lấy từ `memory_adapter.js` của provider 9.12.2 (file:line
 * trích trong comment từng method). Provider gọi adapter theo `kind` của model
 * (`base_model.js:26-34`: `new Adapter(obj.name)`), mọi method đều nhận/tra theo `jti`.
 */

import type { PostgresClientConfig } from '@ecoma-io/auth-infrastructure';
import { withPostgresClient } from '@ecoma-io/auth-infrastructure';

/**
 * Cổng kiểm tại thời điểm PHÁT HÀNH artifact grantable (§6.0, SR-015, FR-020).
 *
 * Provider gọi `adapter.upsert` MỖI lần cấp AuthorizationCode (resume sau push/consent)
 * và MỖI lần rotate RefreshToken — tức đây là chỗ DUY NHẤT phủ được cả hai thời điểm
 * phát hành mà docs yêu cầu kiểm lại: account status (`suspended|deleted|not_found` và
 * unknown phải chặn — `auth` hỏi `account` qua Service Binding) và `token_revocations`
 * (ba mức subject/client/token). `checkStatus` NÉM khi hạ tầng không trả lời —
 * fail-closed đúng bảng §6.0; một lần ném làm browser thấy 500 ở resume/refresh thay vì
 * nhận code/token, đúng nghĩa "không cấp trong trạng thái unknown".
 *
 * ⚠️ Callback NÉM để chặn cấp — KHÔNG trả boolean: quên kiểm return-value là lỗi kinh
 * điển, ném là không thể bỏ qua. Adapter không hiểu "suspended" hay "revoked" — nó
 * chỉ điều phối, quyền quyết định nằm ở caller-dựng-runtime.
 */
export interface IssuanceGate {
  /**
   * @param accountId — subject của artifact (`payload.accountId` của provider).
   * @param clientId — client nhận artifact (`payload.clientId`).
   * @param grantId — grant gắn artifact (`payload.grantId`) — mục tiêu của mức
   *   `token` trong `token_revocations`.
   */
  readonly assertIssuable: (params: {
    readonly accountId: string;
    readonly clientId: string;
    readonly grantId: string | null;
  }) => Promise<void>;
}

/**
 * Tập kind grantable của provider — bản chép của `lib/adapters/memory_adapter.js:19-27`.
 *
 * Chỉ các kind trong tập này mới được lập chỉ mục `grant_id` khi `upsert` mang
 * `payload.grantId`; migration `0013` chặn cùng tập đó bằng
 * `oidc_state_grant_kind_check`. Hai tập này phải đồng bộ — test parity canh.
 *
 * DeviceCode nằm trong tập gốc của provider nhưng bị loại ở đây vì feature device flow
 * KHÔNG bật trong cấu hình của `auth` (CHECK của `0013` cũng không chứa nó trong các
 * kind được phép): bật feature mà quên mở CHECK sẽ fail ngay lúc chạy, đúng thiết kế
 * fail-closed của migration.
 */
const GRANTABLE_KINDS: ReadonlySet<string> = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
]);

/**
 * Các kind có vòng đời consume-once — gốc của `oidc_state_consumed_kind_check` trong
 * `0013`. `DeviceCode` nằm trong tập schema (vì CHECK viết tường minh tập hợp lệ khi
 * `consumed_at` có giá trị) nhưng với cấu hình hiện tại không bao giờ xuất hiện.
 */
const CONSUMABLE_KINDS: ReadonlySet<string> = new Set(['AuthorizationCode', 'RefreshToken']);

/** Hàng `auth.oidc_state` như PostgreSQL trả về. */
interface OidcStateRow {
  kind: string;
  id: string;
  payload: unknown;
  expires_at: Date;
  consumed_at: Date | null;
  grant_id: string | null;
  uid: string | null;
  user_code: string | null;
}

/**
 * Adapter cho một kind của provider.
 *
 * Provider cache một instance mỗi model class (`base_model.js:26-34`), nên constructor
 * chạy đúng một lần cho mỗi kind trong đời isolate — việc giữ `this.kind` ở đây không
 * phải state phục vụ request.
 *
 * ⚠️ **Không giữ client nào trong instance** (issue #289): mọi method mở MỘT client
 * qua {@link withPostgresClient} và đóng ngay trong cùng request. Instance sống
 * theo isolate (provider cache nó theo model class) nhưng chỉ cầm opener — một
 * closure thuần trên config, không socket, không pool.
 */
export class PostgresAdapter {
  private readonly kind: string;
  private readonly clientConfig: PostgresClientConfig;
  private readonly issuanceGate?: IssuanceGate;

  constructor(kind: string, openerConfig: PostgresClientConfig, issuanceGate?: IssuanceGate) {
    this.kind = kind;
    this.clientConfig = openerConfig;
    this.issuanceGate = issuanceGate;
  }

  /**
   * Ghi payload với TTL (giây).
   *
   * `upsert` vì cả INSERT lần đầu lẫn UPDATE khi `persist()` đều đi qua đây
   * (`base_model.js:82-89`). TTL có thể là số dương bất kỳ — kể cả ≤ 0 với
   * ReplayDetection khi `exp` đã quá khứ (`replay_detection.js:32`); PostgreSQL nhận
   * `timestamptz` quá khứ, hàng chết bị find() lọc ngay dưới.
   *
   * ⚠️ `expires_at` do TA tính từ TTL, không có DEFAULT trong schema — cùng lý do với
   * `internal_nonces` (0010): database tự điền là hàng sống mãi.
   */
  async upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void> {
    // ⚠️ Cổng thời điểm phát hành (SR-015/FR-020/§6.0) — chạy TRƯỚC khi hàng được
    // ghi, đúng nghĩa "không cấp artifact khi trạng thái không cho phép". Phủ CẢ BA
    // kind grantable trong tập GRANTABLE_KINDS. ⚠️ Lệch thực thi đã biết (deviation):
    // với `accessTokenFormat: 'jwt'` (provider.ts), `formats/jwt.js` trả `{ value }`
    // không có `payload`, nên `base_model.js` không gọi upsert cho AccessToken —
    // cửa sổ không gate tối đa là TTL code (≤ 60s) giữa resume và cấp refresh đầu
    // tiên; refresh token (rotation) vẫn được gate ở MỌI lần rotate. Nếu đổi sang
    // opaque AT (hoặc provider đổi cơ chế persist), gate này tự áp dụng cho AT
    // mà không cần sửa gì. Chi phí mỗi lần gate là một round trip Account + một
    // SELECT; chọn chặt hơn latency ở đường này.
    if (GRANTABLE_KINDS.has(this.kind) && this.issuanceGate !== undefined) {
      const accountId = typeof payload.accountId === 'string' ? payload.accountId : '';
      const clientId = typeof payload.clientId === 'string' ? payload.clientId : '';
      const grantId = grantIdOf(this.kind, payload);
      if (accountId === '' || clientId === '') {
        // Không thể kiểm mà vẫn cấp là mở cửa im lặng — ném fail-closed thay vì
        // cấp một artifact không biết chủ.
        throw new Error(`issuance gate thieu accountId/clientId cho kind ${this.kind}`);
      }
      await this.issuanceGate.assertIssuable({ accountId, clientId, grantId });
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    // Payload của provider có `consumed` (giây epoch) sau khi consume; giữ cột
    // `consumed_at` đồng bộ ngay từ lúc ghi để hàng viết lại (persist) không mất dấu.
    const consumedPayload = payload.consumed;
    const consumedAt =
      typeof consumedPayload === 'number' ? new Date(consumedPayload * 1000) : null;

    // ⚠️ `kind` đi vào CHECK allowlist, id/payload đi qua bind — không có giá trị nào
    // từ request chạm chuỗi SQL.
    // ⚠️ payload bind TRỰC TIẾP object, KHÔNG `JSON.stringify`: postgres.js serialise
    // object sang jsonb riêng cho driver — truyền string là Postgres nhận cả chuỗi
    // làm MỘT giá trị jsonb-scalar (jsonb_typeof = 'string', double-encoded) và
    // mọi query `payload->'params'` trả null (đúng lệch mà acceptance test bắt được
    // ở index `oidc_state_interaction_ecoma_x_idx`). Lúc đọc, driver parse ngược
    // thành object — khớp `rowToPayload`.
    await withPostgresClient(this.clientConfig, async (client) => {
      await client.unsafe(
        `INSERT INTO auth.oidc_state (kind, id, payload, expires_at, consumed_at, grant_id, uid, user_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, id) DO UPDATE SET
         payload = EXCLUDED.payload,
         expires_at = EXCLUDED.expires_at,
         consumed_at = EXCLUDED.consumed_at,
         grant_id = EXCLUDED.grant_id,
         uid = EXCLUDED.uid,
         user_code = EXCLUDED.user_code`,
        [
          this.kind,
          id,
          payload,
          expiresAt,
          consumedAt,
          grantIdOf(this.kind, payload),
          uidOf(this.kind, payload),
          userCodeOf(payload),
        ],
      );
    });
  }

  /**
   * Tra theo jti. Trả payload NGUYÊN VẠN — provider tự kiểm hạn khi verify
   * (`helpers/jwt.js` `assertPayload`), adapter KHÔNG lọc theo `expires_at` ở đây.
   *
   * Lý do không lọc: `find()` của BaseModel (`base_model.js:120-133`) bắt lỗi verify và
   * trả `undefined`, nên một hàng hết hạn đã có hành vi đúng của provider. Lọc sớm hơn
   * bằng SQL là tối ưu, nhưng nó khiến adapter có chính sách thời gian riêng — lệch
   * `clockTolerance` của provider — và khi đó một artifact còn hạn theo provider nhưng
   * hết hạn theo adapter sẽ biến mất im lặng.
   */
  async find(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await withPostgresClient(this.clientConfig, (client) =>
      client.unsafe<OidcStateRow>('SELECT * FROM auth.oidc_state WHERE kind = $1 AND id = $2', [
        this.kind,
        id,
      ]),
    );
    return rowToPayload(rows);
  }

  /**
   * Secondary index của Session — `models/session.js:37-46` tra theo `uid`.
   *
   * Cột `uid` được upsert ghi từ `payload.uid`; UNIQUE partial index
   * `oidc_state_session_uid_key` bảo đảm một uid không map được hai hàng sống.
   */
  async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const rows = await withPostgresClient(this.clientConfig, (client) =>
      client.unsafe<OidcStateRow>('SELECT * FROM auth.oidc_state WHERE kind = $1 AND uid = $2', [
        this.kind,
        uid,
      ]),
    );
    return rowToPayload(rows);
  }

  /**
   * Secondary index của device flow — không dùng với cấu hình hiện tại (feature tắt),
   * giữ cho đúng hợp đồng adapter.
   */
  async findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    const rows = await withPostgresClient(this.clientConfig, (client) =>
      client.unsafe<OidcStateRow>(
        'SELECT * FROM auth.oidc_state WHERE kind = $1 AND user_code = $2',
        [this.kind, userCode],
      ),
    );
    return rowToPayload(rows);
  }

  /**
   * Đánh dấu consume-once.
   *
   * ⚠️ Ghi CẢ HAI nơi cùng một câu: `consumed_at` (cột, cho prune/vận hành) và
   * `payload->consumed` (giây epoch, là thứ provider đọc khi verify —
   * `base_model.js:120-133` verify lại toàn bộ payload; `refresh_token.js:52-54` đọc
   * `this.consumed` từ payload). Chỉ ghi cột mà không ghi payload thì provider vẫn thấy
   * token còn dùng được — consume-once vô hiệu trong im lặng.
   *
   * ⚠️ Không CAS ở đây: provider tự bảo đảm consume-once (AuthorizationCode bị consume
   * ngay sau khi cấp token; RefreshToken bị consume lúc rotate — `actions/grants/
   * authorization_code.js:64`, `actions/grants/refresh_token.js:124`), và `consume()`
   * trên một id đã consume chỉ là ghi lại cùng sự kiện.
   */
  async consume(id: string): Promise<void> {
    if (!CONSUMABLE_KINDS.has(this.kind)) {
      // Provider chỉ gọi consume trên AuthorizationCode/RefreshToken/DeviceCode; một
      // lời gọi ngoài tập là bug điều phối — ném thay vì ghi cột lên kind sai kind.
      throw new Error(`consume() khong ap dung cho kind ${this.kind}`);
    }
    const nowEpoch = Math.floor(Date.now() / 1000);
    await withPostgresClient(this.clientConfig, async (client) => {
      await client.unsafe(
        `UPDATE auth.oidc_state
       SET consumed_at = to_timestamp($3),
           payload = jsonb_set(payload, '{consumed}', to_jsonb($3::bigint), true)
       WHERE kind = $1 AND id = $2`,
        [this.kind, id, nowEpoch],
      );
    });
  }

  /**
   * Xoá một artifact.
   *
   * Đường gọi chính: `Session.save()` xoá hàng `oldId` khi resetIdentifier
   * (`models/session.js:85-89`), authorization resume xoá Interaction ngay khi áp result
   * (`actions/authorization/resume.js:71`), reuse detection xoá refresh token đã dùng
   * (`actions/grants/refresh_token.js:108`).
   */
  async destroy(id: string): Promise<void> {
    await withPostgresClient(this.clientConfig, (client) =>
      client.unsafe('DELETE FROM auth.oidc_state WHERE kind = $1 AND id = $2', [this.kind, id]),
    );
  }

  /**
   * Thu hồi MỌI token của một grant — RFC 7009 §2.1 và reuse detection.
   *
   * Provider gọi trên TỪNG model grantable (`helpers/revoke.js:32-40`:
   * `model.revokeByGrantId(grantId)`); một model không grantable (Interaction, Session,
   * Grant…) không bao giờ bị gọi — nhưng vẫn chặn sớm để một sai sót điều phối không trở
   * thành xoá-hàng-loạt-im-lặng.
   *
   * ⚠️ `Grant.adapter.destroy(grantId)` (`revoke.js:44-47`) đi qua `destroy`, không qua
   * đây — grant bị xoá bằng chính id của nó, không phải theo index.
   */
  async revokeByGrantId(grantId: string): Promise<void> {
    if (!GRANTABLE_KINDS.has(this.kind)) {
      throw new Error(`revokeByGrantId() khong ap dung cho kind ${this.kind}`);
    }
    await withPostgresClient(this.clientConfig, (client) =>
      client.unsafe('DELETE FROM auth.oidc_state WHERE kind = $1 AND grant_id = $2', [
        this.kind,
        grantId,
      ]),
    );
  }
}

/**
 * Nạp một payload từ kết quả truy vấn — chống sai hình dạng kết quả.
 *
 * ⚠️ Cùng học thuyết với `NonceStoreContractError` của `postgres.ts`: một `Queryable`
 * trả hình dạng khác mảng hàng phải NÉM, không phải được diễn giải. `undefined` do hình
 * dạng sai sẽ để provider coi artifact "chưa từng tồn tại" — với Session/Interaction đó
 * là đăng xuất im lặng của người dùng thật.
 */
function rowToPayload(rows: OidcStateRow[]): Record<string, unknown> | undefined {
  if (!Array.isArray(rows)) {
    throw new Error('oidc adapter: Queryable phai tra ve mang hang (postgres.js)');
  }
  if (rows.length === 0) {
    return undefined;
  }
  const row = rows[0];
  if (typeof row?.payload !== 'object' || row.payload === null) {
    throw new Error('oidc adapter: payload cua oidc_state phai la jsonb object');
  }
  return row.payload as Record<string, unknown>;
}

/** `grant_id` chỉ có ý nghĩa với kind grantable — cùng tập của schema CHECK. */
function grantIdOf(kind: string, payload: Record<string, unknown>): string | null {
  if (!GRANTABLE_KINDS.has(kind)) {
    return null;
  }
  return typeof payload.grantId === 'string' ? payload.grantId : null;
}

/** `uid` chỉ tồn tại trên Session (`memory_adapter.js:126`). */
function uidOf(kind: string, payload: Record<string, unknown>): string | null {
  if (kind !== 'Session') {
    return null;
  }
  return typeof payload.uid === 'string' ? payload.uid : null;
}

/**
 * `userCode` của device flow. KHÔNG lọc theo kind: feature tắt nghĩa là không model nào
 * mang trường này, kiểm kind ở đây là kiểm thừa — nhưng vẫn phải đọc đúng trường mà
 * provider đặt vào payload.
 */
function userCodeOf(payload: Record<string, unknown>): string | null {
  return typeof payload.userCode === 'string' ? payload.userCode : null;
}

/**
 * Sinh adapter cho một provider instance.
 *
 * ⚠️ **Vòng đời client của adapter: MỖI thao tác MỘT client** (issue #289 — ngược
 * lại với bản ghi cũ "pool thuộc về isolate" ở đây). Socket mà postgres.js mở qua
 * polyfill `cloudflare:sockets` gắn với request context đã tạo nó, nên một client
 * dùng chung theo isolate là lỗi chéo-request (`Cannot perform I/O on behalf of a
 * different request`). Adapter nhận config và bọc từng method trong
 * `withPostgresClient` — client sống đúng một thao tác, `end()` trong `finally`.
 * Chi phí là một `end()`/thao tác: connection đi qua pool của Hyperdrive, không
 * giữ connection origin nào giữa hai thao tác.
 *
 * ⚠️ Mọi method của `PostgresAdapter` hiện là single-statement (mỗi câu SQL tự
 * đứng). Không có khối `begin` nào nằm trong adapter — nếu sau này một method cần
 * transaction, khối `begin` PHẢI nằm trọn trong `fn` của MỘT lời gọi
 * `withPostgresClient` (một transaction = một client).
 */
export function createAdapterFactory(
  postgresClientConfig: PostgresClientConfig,
  issuanceGate?: IssuanceGate,
): (kind: string) => PostgresAdapter {
  // Provider cache instance theo class (`base_model.js:26-34`) nên mỗi kind chỉ được
  // tạo một lần; nhưng cache lại tại đây vẫn rẻ và chặn đường hai instance cho cùng
  // kind nếu provider đổi cơ chế cache.
  const cache = new Map<string, PostgresAdapter>();
  return (kind: string) => {
    let adapter = cache.get(kind);
    if (adapter === undefined) {
      adapter = new PostgresAdapter(kind, postgresClientConfig, issuanceGate);
      cache.set(kind, adapter);
    }
    return adapter;
  };
}
