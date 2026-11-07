/**
 * Glue giữa back-channel ECOMA (`account → auth`) và Interaction của `oidc-provider`.
 *
 * ## Vì sao glue tồn tại
 *
 * Provider chỉ biết đẩy user qua Interaction theo một đường duy nhất: redirect browser
 * tới trang interaction (`interactions.url`), rồi khi browser quay lại resume URL với
 * cookie `_interaction_resume` (interactions.js:133-153), middleware resume
 * (`resume.js:17-34`) đọc cookie đó để tìm Interaction và áp `result`.
 *
 * Luồng ECOMA ĐỨT đường đó ở một chỗ: `account` là bên giữ browser trong lúc đăng
 * nhập/consent (§5.1.1), còn kết quả đến `auth` bằng **back-channel** — request POST
 * đã xác thực HMAC, KHÔNG mang cookie của browser. Mà `provider.interactionFinished`
 * (`provider.js:224-249`, `#getInteraction` :426-450) ĐÒI cookie `interaction` trên
 * request; không có cookie là `SessionNotFound`. Vì vậy glue NẠP Interaction qua
 * adapter (theo handle X correlator trong `params.ecoma_x`), set `result` trực tiếp
 * và persist; browser sau đó đi theo `returnTo` → resume middleware đọc lại `result`
 * từ adapter → cấp provider code → redirect `redirect_uri` của client. Cookie resume
 * vẫn do provider set ở lúc interaction.started nên browser của transaction giữ
 * được; back-channel không cần nó.
 *
 * ## Chia hai phần để test
 *
 * Mọi thứ đụng tới instance `Provider` sống (`Interaction.find`, `Grant`) gom vào
 * `attachInteractionResult`; phần thuần (`hashHandle` qua callback, derive Y/Z, xây
 * `result`) là các hàm rời không import provider — unit test được không cần DB.
 */

import {
  HANDLE_DOMAINS,
  OAuthProtocolError,
  deriveHandle,
  hashHandle,
} from '@ecoma-io/auth-domain';

import type {
  Provider,
  ProviderGrant,
  ProviderInteraction,
  InteractionResultInput,
} from 'oidc-provider';

/**
 * Tham số tương quan Interaction ↔ transaction ECOMA.
 *
 * ⚠️ `ecoma_x` là handle X BẢN RÕ, được glue gắn vào authorize params trước khi
 * provider phân tích (`extraParams` của cấu hình). BẢN RỠ, không phải hash: vế bên
 * kia của phép so là `handle_hash_x` của transaction — glue hash bản rõ tìm thấy
 * rồi mới so, cùng cách `confirmBrowser` so cookie trình duyệt.
 */
export const ECOMA_X_PARAM = 'ecoma_x';

/**
 * Kết quả gắn result vào Interaction.
 *
 * `continueUrl` là `interaction.returnTo` — resume URL **của provider**, dạng tuyệt
 * đối (`oidc_context.js:77-85` dựng từ `provider.pathFor` + ctx.href). §5.1.1 đòi
 * `continue_url` là URL tuyệt đối do `auth` dựng và KHÔNG mang credential: resume URL
 * chỉ chứa `:uid` của Interaction (nanoid), là opaque artifact sống 600s và bị xoá
 * ngay khi resume tiêu thụ (`resume.js:73`) — đúng tính chất một continuation handle.
 */
export interface AttachedInteraction {
  readonly interaction: ProviderInteraction;
  readonly continueUrl: string;
}

/**
 * Nạp Interaction của một transaction theo handle X và gắn `result` vào đó.
 *
 * `result` TUỲ CHỌN: bỏ qua thì Interaction chỉ được NẠP (đọc `returnTo`) —
 * dùng cho replay §5.1.5a, nơi result đã được gắn ở event gốc và một phép gắn
 * thứ hai với object rỗng sẽ XOÁ chính result đó.
 *
 * Trả về `undefined` khi không tìm thấy Interaction tương ứng — caller quyết định
 * hành vi (ví dụ nhánh đã-có-grant không có Interaction nào để gắn).
 */
export async function attachInteractionResult(params: {
  readonly provider: Provider;
  readonly postgresClient: import('@ecoma-io/auth-infrastructure').PostgresClientLike;
  readonly handleX: string;
  readonly result?: InteractionResultInput;
}): Promise<AttachedInteraction | undefined> {
  const { provider, postgresClient, handleX, result } = params;

  // Correlate qua index biểu thức của 0013: payload->'params'->>'ecoma_x'.
  // ⚠️ Chỉ `kind = 'Interaction'` được xét: index 0013 là partial index trên
  // Interaction; lọc kind ở đây để câu lệnh khớp đúng index đó thay vì quét toàn bảng.
  const rows = await postgresClient.unsafe<{ id: string }>(
    `SELECT id FROM auth.oidc_state
      WHERE kind = 'Interaction'
        AND payload->'params'->>'ecoma_x' = $1`,
    [handleX],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }

  // Nạp qua model của provider — KHÔNG thao tác payload thô:
  // `Interaction.find` chạy verify (base_model.js:120-133) nên một interaction
  // hết hạn trả `undefined` thay vì một object nửa sống.
  const interaction = await provider.Interaction.find(row.id);
  if (interaction === undefined) {
    return undefined;
  }

  if (result !== undefined) {
    interaction.result = result;
    // persist() dùng TTL còn lại (`this.exp - epochTime()`, models/interaction.js:48-51)
    // — KHÔNG gia hạn interaction khi gắn result.
    await interaction.persist();
  }

  return { interaction, continueUrl: interaction.returnTo };
}

/**
 * Dựng `result.login` cho Interaction từ payload đã xác thực của `account`.
 *
 * ⚠️ `ts` là epoch GIÂY (resume.js:100-104 đọc vào `loginTs` rồi session ghi
 * `authTime`), không phải ms như `authn_at` trên wire — đổi đơn vị ở ĐÚNG một chỗ
 * này, và comment ghi rõ, để không có call site nào tự chia 1000 lần nữa.
 */
export function buildLoginResult(params: {
  readonly sub: string;
  readonly acr: string;
  readonly authnAtMs: number;
}): InteractionResultInput {
  return {
    login: {
      // `remember = true`: session của provider sống theo ttl.Session (30d) —
      // tuổi thọ SSO không do request này quyết định.
      remember: true,
      accountId: params.sub,
      ts: Math.floor(params.authnAtMs / 1000),
      acr: params.acr,
    },
  };
}

/**
 * Xây provider Grant cho một consent được chấp thuận.
 *
 * Grant của provider là "quyền hiện hành" thứ hai, SONG SONG với `oauth_grants` của
 * `db-auth` (0003): provider đọc nó qua `loadExistingGrant` (defaults.js:544-552) ở
 * mọi lần token/refresh sau này, còn `oauth_grants` là nơi control plane thu hồi và
 * audit. Hai bảng KHÔNG đồng bộ tự động — glue là chỗ hai bên được ghim với nhau:
 * id của provider Grant CHÍNH là uuid của `oauth_grants` (truyền vào `jti`), nên
 * thu hồi theo grantId trên một vế là thu hồi đúng trên vế kia.
 *
 * Scope: `addOIDCScope` nhận toàn bộ scope được yêu cầu (đã qua `filterAllowedScopes`
 * lúc `/authorize`), kể cả `offline_access` — provider cấp refresh token dựa trên
 * scope này có trong grant (defaults.js:305-310), không dựa trên giá trị nào khác.
 * `addOIDCClaims(['sub'])` khớp CLAIMS của cấu hình; thiếu dòng này consent check
 * (`op_claims_missing`, prompts/consent.js) có thể đòi prompt lại dù scope đủ.
 */
export function createProviderGrant(params: {
  readonly provider: Provider;
  readonly accountId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Id của grant ECOMA (`oauth_grants.id`) — dùng làm jti của provider Grant. */
  readonly grantId: string;
  readonly ttlSeconds: number;
}): ProviderGrant {
  const grant = new params.provider.Grant({ jti: params.grantId });
  grant.accountId = params.accountId;
  grant.clientId = params.clientId;
  // `openid` phải luôn nằm trong OIDC scope (OIDC Core §3.1.2.1) — đảm bảo có dù
  // caller truyền scope đã lọc.
  grant.addOIDCScope(['openid', ...params.scopes.filter((s) => s !== 'openid')].join(' '));
  grant.addOIDCClaims(['sub']);
  // `offline_access` là scope OIDC (đã khai trong SCOPES) nên đi qua addOIDCScope;
  // KHÔNG addResourceScope — resource indicator của `auth` được cấp qua
  // defaultResource ở token time, không qua grant resource.
  return grant;
}

/**
 * Lưu provider Grant và trả jti để nhét vào `result.consent.grantId`.
 *
 * Tách khỏi `createProviderGrant` vì đây là bước I/O — unit test dựng/đọc grant
 * thuần không cần DB.
 */
export async function saveProviderGrant(grant: ProviderGrant, ttlSeconds: number): Promise<string> {
  return grant.save(ttlSeconds);
}

/**
 * Kết quả của đường `session/verified` và `consent/decide` dùng chung — handles Y/Z
 * đã derive cho transaction hiện tại.
 */
export interface TransactionHandles {
  readonly handleY: string | undefined;
  readonly handleZ: string;
}

/**
 * Derive handle Y/Z cho transaction — §5.6: HMAC theo domain, cùng `transaction_id`.
 *
 * Z được derive TRƯỚC khi transaction vào `ready_to_complete`, vì cả nhánh
 * granted (không qua consent) lẫn nhánh approved đều phải trả cùng một Z khi retry
 * (`event_id` hoặc Y replay) — derive-on-demand tính lại được, không cần lưu bản rõ.
 */
export async function deriveContinuationHandles(params: {
  readonly handleKey: string;
  readonly transactionId: string;
}): Promise<{ readonly handleY: string; readonly handleZ: string }> {
  const [handleY, handleZ] = await Promise.all([
    deriveHandle({
      key: params.handleKey,
      transactionId: params.transactionId,
      domain: HANDLE_DOMAINS.consentContinuation,
    }),
    deriveHandle({
      key: params.handleKey,
      transactionId: params.transactionId,
      domain: HANDLE_DOMAINS.authorizationCode,
    }),
  ]);
  return { handleY, handleZ };
}

/**
 * Ném lỗi protocol CÓ ĐIỀU KIỆN cho back-channel.
 *
 * Lỗi back-channel KHÔNG BAO GIỜ redirect: caller là `account`, không phải browser,
 * nên `redirectable` phải là false tuyệt đối — dù lỗi đến từ đâu. Hàm này là chỗ
 * duy nhất chuẩn hoá điều đó để không có call site nào vô tình dùng biến thể
 * redirectable của `OAuthProtocolError` cho response 200/4xx JSON.
 */
export function backChannelError(
  code: Parameters<typeof OAuthProtocolError.directInvalidRequest>[0] extends never
    ? 'invalid_request' | 'invalid_grant' | 'access_denied'
    : 'invalid_request' | 'invalid_grant' | 'access_denied',
  detail: string,
): OAuthProtocolError {
  if (code === 'invalid_grant') {
    return new OAuthProtocolError('invalid_grant', 400, { redirectable: false, detail });
  }
  if (code === 'access_denied') {
    return new OAuthProtocolError('access_denied', 400, { redirectable: false, detail });
  }
  return new OAuthProtocolError('invalid_request', 400, { redirectable: false, detail });
}

/**
 * Băm handle để so với cột `handle_hash_*` của transaction.
 *
 * Bọc mỏng quanh `hashHandle` để main.ts không import trực tiếp từ domain cho một
 * việc dùng chung với glue — và để unit test stub được hàm băm nếu cần.
 */
export async function handleHash(handle: string): Promise<string> {
  return hashHandle(handle);
}
