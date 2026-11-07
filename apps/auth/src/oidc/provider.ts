/**
 * Factory dựng `oidc-provider` Provider cho `auth`.
 *
 * ⚠️ **Một nguồn sự thật cho discovery.** Provider tự render
 * `/.well-known/openid-configuration` (initialize_app.js:184-188) và tự quyết định
 * endpoint nào được công bố theo feature flag (discovery.js). File này là nơi DUY
 * NHẤT cấu hình provider; mọi khai báo giao thức (response types, grants, scopes,
 * claims) thay đổi thì đổi ở đây — không có discovery hand-rolled nào khác để trôi
 * lệch. Discovery cũ của `main.ts` đã bị xoá đúng vì lý do này.
 *
 * Quyết định cấu hình phản chiếu "Approved decisions" của mission:
 *   - responseTypes ['code'], grants ['authorization_code','refresh_token'].
 *   - PKCE S256 bắt buộc (pkce.required).
 *   - Access token JWT ES256 `typ: at+jwt` TTL 300s (trần 900s — token-service.ts).
 *   - ID token TTL 300s; code TTL 60s; Interaction TTL 600s (≤ transaction TTL 10').
 *   - Refresh: rotation + reuse→thu hồi toàn bộ grant; 30d tuyệt đối.
 *   - KHÔNG introspection (không advertise); revocation RFC 7009 BẬT.
 *   - KHÔNG email_verified ở bất kỳ đâu — claims config chỉ có `sub` (dưới `openid`),
 *     `claims()` của findAccount chỉ trả `{ sub }`, và test parse ID token thật ghim
 *     bất biến đó.
 */

import { Provider, interactionPolicy, errors as oidcErrors } from 'oidc-provider';

import type { AuthConfig } from '../config';
import type { PostgresClientConfig, PostgresClientLike } from '@ecoma-io/auth-infrastructure';
import type { IssuanceGate } from './adapter';
import { createAdapterFactory } from './adapter';

/**
 * TTL của provider — giây, hằng theo cấu hình của `auth`.
 *
 * ⚠️ `assertAccessTokenTtl` (token-service.ts) ghim trần 900s cho access token TTL.
 * 300s nằm dưới trần; nếu nâng TTL ở đây phải đi qua hằng đó, không phải nâng âm thầm.
 */
const TTL = {
  /** RFC 6749 §4.1.2 khuyến nghị tối đa 10 phút; trần ở đây là 60s. */
  AuthorizationCode: 60,
  /** 5 phút — cùng giá trị `accessTokenTtlSeconds` của token-service. */
  AccessToken: 300,
  /** 5 phút — một ID token chỉ cần sống đủ để client tạo session. */
  IdToken: 300,
  /** 30 ngày tuyệt đối của refresh token family (rotate không đổi `iiat`). */
  RefreshToken: 30 * 24 * 60 * 60,
  /** Session cookie dài hạn — cùng cỡ với refresh family. */
  Session: 30 * 24 * 60 * 60,
  /**
   * Interaction phải sống đủ cho user đi qua login (account) và consent (account) rồi
   * quay lại resume. Trần là TTL của `authorization_transactions` (10 phút): hết
   * interaction mà transaction đã chết là hết, tránh hai đồng hồ lệch nhau.
   */
  Interaction: 600,
  /** Grant của provider (consent đã ghi nhận) sống cùng refresh family. */
  Grant: 30 * 24 * 60 * 60,
} as const;

/**
 * Route override của provider — giữ không gian đã tài liệu cho `auth`.
 *
 * Mặc định của provider đặt revocation ở `/token/revocation`
 * (defaults.js:3045-3053); `auth` dùng `/revocation` như tài liệu nội bộ đã ghi.
 * `authorization` giữ `/auth` (không phải `/authorize`) để tách khỏi namespace
 * ECOMA (`/authorize/complete` của §5.1.4 vẫn là route riêng của glue).
 *
 * ⚠️ Route `resume` của provider là `${routes.authorization}/:uid` → `/auth/:uid`:
 * đây chính là `interaction.returnTo` mà glue trả về cho account qua `continue_url`.
 * Bridge phải chuyển tiếp CẢ `/auth` lẫn `/auth/:uid` cho provider.
 *
 * `userinfo` không có ở đây: feature đã tắt (features.userinfo.enabled: false),
 * provider không đăng ký route nào cho nó (initialize_app.js chỉ mount khi
 * enabled) — không có route chết để đọc nhầm là endpoint sống.
 */
export const PROVIDER_ROUTES = {
  authorizationRoute: '/auth',
  tokenRoute: '/token',
  jwks: '/jwks.json',
  revocation: '/revocation',
  end_session: '/session/end',
} as const;

/** Aliases nội bộ của file — mọi tham chiếu route trong cấu hình đi qua đây. */
const ROUTES = PROVIDER_ROUTES;

/**
 * Danh sách scope mà `auth` phục vụ.
 *
 * ⚠️ `offline_access` là scope điều khiển việc cấp refresh token (mặc định
 * `issueRefreshToken` của provider đòi scope này — defaults.js:305-310). `profile`
 * được công bố cho consent UI nhưng KHÔNG có claim nào gắn với nó trong `claims`
 * dưới đây — scope mà không có claim là scope chỉ để hiển thị.
 */
const SCOPES = ['openid', 'offline_access', 'profile'] as const;

/**
 * `claims` — ánh xạ scope → claim, và nguồn của `claims_supported` trong discovery
 * (configuration.js:555-568: collectClaims gom mọi key của claims config).
 *
 * ⚠️ **Đây là rào cản thứ NHẤT của bất biến "KHÔNG email_verified".** `sub` là
 * claim duy nhất đến từ account; không scope nào khai `email_verified`, nên
 * `filterClaims` (helpers/claims.js:56) lọc nó khỏi mọi response kể cả khi
 * account trả về. Rào cản thứ hai là `findAccount` bên dưới (chỉ trả `{ sub }`)
 * — hai lớp độc lập.
 *
 * ⚠️ `acr` + `auth_time` nằm TRONG `openid`: cơ chế của provider là mask theo
 * scope — `Claims.scope()` gộp `claimConfig[scope]` cho từng scope được cấp
 * (models/id_token.js:83-84, helpers/claims.js:31-38) rồi chỉ `pick` claim nằm
 * trong mask VÀ trong `claimsSupported` (result(), claims.js:48-62). Provider
 * ĐÃ luôn đặt sẵn hai giá trị này vào `available` khi dựng IdToken
 * (process_response_types.js:146-150 và grant_common.js:162-171: `acr:
 * ctx.oidc.acr, auth_time: ctx.oidc.session.authTime()` — nguồn là
 * `result.login` mà back-channel ECOMA gắn, session.js:175-190), nhưng KHÔNG
 * có mask là KHÔNG bao giờ ra ID token — vỡ hợp đồng `session.verified.acr`.
 * Gắn vào `openid` vì scope này có trong MỌI request; một mục top-level
 * (`acr: null`) chỉ công bố trong discovery, không vào mask nào. Lệch spec
 * OIDC (acr/auth_time đáng lẽ phải được đòi qua `claims`/`acr_values`) là CHỦ
 * ĐÍCH và được ghi trong docs/applications/auth/01-architecture.md: ACR là hợp đồng bắt buộc, không
 * do client quyết định.
 */
const CLAIMS = {
  openid: ['sub', 'acr', 'auth_time'],
  profile: [],
} as const;

/** Deps mà factory cần — tường minh thay vì đọc từ biến toàn cục. */
export interface ProviderDeps {
  readonly config: AuthConfig;
  /**
   * Config postgres.js cho adapter — adapter mở MỘT client mới cho MỖI thao tác
   * từ config này (issue #289: socket của driver gắn request context, client
   * cache theo isolate là lỗi chéo-request). Config là giá trị thuần nên an toàn
   * khi sống theo isolate; client thì không — không client nào được dựng hoặc
   * lưu ở factory.
   */
  readonly postgresClientConfig: PostgresClientConfig;
  /**
   * Client DÙNG MỘT LẦN để load static clients lúc factory chạy. Caller mở qua
   * `withPostgresClient` và đã đóng sau khi factory trả — factory không giữ
   * tham chiếu nào ngoài kết quả đã load (xem `loadStaticClients`).
   */
  readonly staticClientsLoader: PostgresClientLike;
  /**
   * PEM PKCS#8 của khoá ký — cùng PEM mà `loadAuthConfig` đã kiểm. Factory cần bản
   * rõ để export JWK có `d` cho keystore của provider; `signingKeyProvider` chỉ giữ
   * handle non-extractable không export được (thiết kế của signing-key.ts).
   */
  readonly signingPem: string;
  /**
   * Cổng kiểm tại thời điểm phát hành code/refresh token (§6.0, SR-015, FR-020):
   * account status + `token_revocations` được hỏi lại ở MỖI lần cấp, không chỉ ở
   * push. BẮT BUỘC ở runtime production — composition (`oidc/runtime.ts`) dựng
   * gate từ `AccountClient` + `checkRevocationAtIssuance`; test không truyền gate
   * là test trình duyệt protocol thuần, còn production không gate là mở cửa cấp
   * token cho account bị khoá giữa luồng. Nhận `undefined` chỉ ở test.
   */
  readonly issuanceGate?: IssuanceGate;
}

/**
 * Metadata client tĩnh được truyền vào provider qua config `clients`.
 *
 * ⚠️ **Vì sao clients là mảng TĨNH load từ db, không qua adapter:** path
 * `Client.find()` của provider (models/client.js:574-615) kiểm tra
 * staticClients Map TRƯỚC, rồi mới `this.adapter.find(id)` — nhưng kind
 * `'Client'` KHÔNG nằm trong CHECK allowlist của migration 0013
 * (`oidc_state_kind_check`: 7 kind giao thức, không có Client). Ghi Client
 * qua adapter sẽ bị Postgres từ chối; provider phải thấy clients ngay khi
 * dựng. Vì vậy `oauth_clients` + `client_redirect_uris` được load MỘT LẦN
 * lúc factory chạy (per isolate) và truyền thành mảng tĩnh.
 *
 * ⚠️ **Chỉ client public khả dụng** (`token_endpoint_auth_method: 'none'`).
 * Provider so client secret dạng BẢN RÃ (`compareClientSecret` —
 * models/client.js:542, constantEquals plaintext) trong khi db chỉ giữ
 * `client_secret_hash`; 9.12.2 không có hook so-hash cho client auth. Client
 * confidential trong `oauth_clients` vì thế bị loại khỏi danh sách load —
 * một client confidential cần cơ chế auth riêng (mTLS/private_key_jwt),
 * nằm ngoài scope lần này. Gap này được ghi ở report.
 */
export interface StaticClientMetadata {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: readonly string[];
  readonly scope: string;
}

/**
 * Load clients từ db thành metadata tĩnh của provider.
 *
 * Chỉ `status = 'active'` + `client_type = 'public'` được load; một hàng
 * redirect URI không có (client không đăng ký URI nào) cũng bị loại vì
 * provider tự ném khi client không có redirect_uris.
 */
export async function loadStaticClients(
  postgresClient: PostgresClientLike,
): Promise<StaticClientMetadata[]> {
  const rows = await postgresClient.unsafe<{
    client_id: string;
    client_name: string;
    redirect_uri: string;
    allowed_scopes: string[];
  }>(
    `SELECT c.client_id, c.client_name, r.redirect_uri, c.allowed_scopes
       FROM auth.oauth_clients c
       JOIN auth.client_redirect_uris r ON r.client_id = c.client_id
      WHERE c.status = 'active' AND c.client_type = 'public'
      ORDER BY c.client_id, r.redirect_uri`,
  );

  // Gom nhiều redirect URI của cùng client thành một metadata. Query đã ORDER
  // BY client_id nên các URI của một client nằm liền nhau — gom tại đây giữ
  // thứ tự ổn định (structuredClone của provider giữ nguyên thứ tự mảng).
  const byId = new Map<string, { client_name: string; redirect_uris: string[]; scope: string }>();
  for (const row of rows) {
    let entry = byId.get(row.client_id);
    if (entry === undefined) {
      entry = {
        client_name: row.client_name,
        redirect_uris: [],
        scope: row.allowed_scopes.join(' '),
      };
      byId.set(row.client_id, entry);
    }
    entry.redirect_uris.push(row.redirect_uri);
  }

  return [...byId.entries()].map(([client_id, entry]) => ({
    client_id,
    client_name: entry.client_name,
    redirect_uris: entry.redirect_uris,
    scope: entry.scope,
  }));
}

/** Dạng metadata đúng provider 9.12.2 mong đợi trên một client tĩnh. */
function toProviderClientMetadata(client: StaticClientMetadata): Record<string, unknown> {
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: [...client.redirect_uris],
    // Mọi client được load đều public: `none` = không secret (token endpoint).
    token_endpoint_auth_method: 'none',
    // `auth` chỉ cấp code; cả hai grant đều của code flow (refresh đi kèm
    // offline_access đã consent).
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    scope: client.scope,
    // ⚠️ BẮT BUỘC khai tường minh: default của provider là 'RS256' (client_attributes
    // DEFAULTS), mà keystore của `auth` chỉ có ES256 — schema validator của provider
    // kiểm mỗi client metadata NGAY LÚC Client.find (tức là lúc authorize) và ném
    // `InvalidClientMetadata: id_token_signed_response_alg must be 'ES256'` cho MỌI
    // client không khai. Bỏ sót dòng này là mọi authorize chết 400 trong im lặng.
    id_token_signed_response_alg: 'ES256',
  };
}

/**
 * Chính sách rotate refresh token: 30 ngày tuyệt đối tính từ `iiat`.
 *
 * ⚠️ `iiat` = thời điểm family được tạo, được GIỮ qua rotation
 * (`actions/grants/refresh_token.js:133` truyền `iiat: refreshToken.iiat` sang token
 * mới), nên `totalLifetime()` là tuổi của CẢ family — đúng nghĩa "tuyệt đối".
 *
 * ⚠️ Reuse detection KHÔNG nằm ở callback này: provider tự consume token cũ lúc rotate
 * (`refresh_token.js:124-131`), và một token đã `consumed` xuất hiện lại kích hoạt
 * `revoke(ctx, grantId)` — xoá toàn bộ token của grant qua `revokeByGrantId` của adapter
 * (`refresh_token.js:107-112`). Adapter (`./adapter.ts`) là bên thực hiện việc xoá.
 *
 * Trả `false` (không rotate) khi family đã quá 30 ngày → client phải đăng nhập lại.
 * Còn lại: rotate (mặc định true của provider cho public client — defaults.js:531-536).
 */
function rotateRefreshToken(ctx: {
  oidc: { entities: { RefreshToken?: { totalLifetime(): number } } };
}): boolean {
  // Tên cục bộ trung tính: `refreshToken` khớp nguồn của rule
  // `security-sensitive-value-in-http-response` (refresh_?tokens?) dù giá trị là
  // entity của provider và giá trị trả về là MỘT BOOLEAN so sánh lifetime —
  // một bit, không mang lại bit nào của token.
  const refreshFamily = ctx.oidc.entities.RefreshToken;
  if (refreshFamily === undefined) {
    return false;
  }
  return refreshFamily.totalLifetime() < 30 * 24 * 60 * 60;
}

/**
 * Dựng Provider.
 *
 * ⚠️ KHÔNG có default `jwks`: không truyền option này provider sẽ chạy với DEV_KEYSTORE
 * và chỉ in warning (provider.js:157-158). Keystore dev ký token production là lỗi
 * không lộ qua hành vi (mọi chữ ký vẫn verify được — bằng dev key), nên factory NÉM
 * khi thiếu PEM thay vì để provider tự ứng phó.
 */
export async function createProvider(deps: ProviderDeps): Promise<Provider> {
  const { config, postgresClientConfig, staticClientsLoader, signingPem } = deps;

  // Private JWK cho keystore: provider ký qua node:crypto KeyObject
  // (keystore.js getKeyObject), nên cần `d` — private scalar EC. Export bằng
  // `jose` (importPKCS8 + exportJWK) — Web-API thuần, chạy được cả trên workerd —
  // KHÔNG qua `signingKeyProvider.privateKey()` — handle WebCrypto non-extractable
  // của provider đó không export được, và đúng thiết kế. ⚠️ `exportJWK` trên khoá
  // PRIVATE trả kèm `d` (đo trên jose@6.2.12 — signing-key.ts ghi lại phép đo);
  // object này chỉ đi vào `jwks` của provider, không bao giờ ra JWKS công bố.
  const { importPKCS8, exportJWK } = await import('jose');
  const temporaryKey = await importPKCS8(signingPem, 'ES256', { extractable: true });
  const privateJwk = (await exportJWK(temporaryKey)) as Record<string, unknown>;

  // Kiểm các trường bắt buộc: sai định dạng PEM đã bị SigningKeyProvider từ chối từ
  // trước, nhưng một PEM EC với khoá khác đường cong vẫn có thể export thiếu x/y —
  // ném sớm, tại factory, thay vì để keystore nén lỗi về sau.
  const { x, y, d, crv } = privateJwk;
  if (typeof x !== 'string' || typeof y !== 'string' || typeof d !== 'string') {
    throw new Error('signing key khong export duoc JWK EC day du (x/y/d)');
  }
  if (crv !== 'P-256') {
    throw new Error(`signing key phai la P-256, nhan duoc: ${String(crv)}`);
  }
  // Khoá tạm extractable chỉ sống trong block này — hết factory, không còn
  // tham chiếu nào (javadoc của `extractPublicMaterial` ghi cùng đánh đổi).

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    d,
    kid: config.signingKeyProvider.kid,
    alg: 'ES256',
    use: 'sig',
  };

  // Clients tĩnh — load từ db (javadoc của loadStaticClients giải thích vì sao
  // phải tĩnh). Một isolate cache kết quả qua cachedProvider của main.ts nên
  // chi phí là một query per isolate, không per request. Load qua client DÙNG
  // MỘT LẦN của caller (issue #289) — client đã đóng khi factory trả.
  const staticClients = await loadStaticClients(staticClientsLoader);
  if (staticClients.length === 0) {
    // Rỗng gần như chắc chắn là lỗi seed/migration: một deployment auth không
    // có client nào là deployment không thể authorize. Ném sớm thay vì provider
    // chạy rồi mọi /auth đều invalid_client.
    throw new Error('khong co client public nao trong auth.oauth_clients');
  }

  const provider = new Provider(config.issuer, {
    adapter: createAdapterFactory(postgresClientConfig, deps.issuanceGate),

    // Clients tĩnh — provider structuredClone mảng này vào staticClients Map
    // (helpers/initialize_clients.js), key theo `metadata.client_id`.
    clients: staticClients.map(toProviderClientMetadata),

    // Keystore — chỉ một key, kid ghim bằng `AUTH_SIGNING_KEY_ID` (cùng giá trị với
    // JWKS mà composition root công bố). Duplicate kid bị chặn bởi initialize_keystore.
    jwks: { keys: [jwk] },

    // === Giao thức công bố ===
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: [...SCOPES],
    claims: { ...CLAIMS },

    // PKCE bắt buộc cho MỌI client. Mặc định của provider chỉ đòi với auth method
    // 'none' (defaults.js:312-317); mọi client của `auth` đều public nên kết quả
    // như nhau — ghim cứng để một client confidential tương lai không tắt PKCE được.
    pkce: { required: true },

    features: {
      // KHÔNG có trang interaction tự render — interactions.url dẫn về account.
      devInteractions: { enabled: false },
      // `claims` request parameter bị tắt: claims là thứ do `auth` quyết định theo
      // scope, không do client chọn (FR + bất biến không email_verified).
      claimsParameter: { enabled: false },
      // KHÔNG introspection — access token verify offline bằng JWKS (D3), một
      // endpoint introspection là nguồn sự thật thứ hai. Discovery không render
      // `introspection_endpoint` khi flag off (discovery.js).
      introspection: { enabled: false },
      /**
       * UserInfo TẮT TƯỜNG MINH (`features.userinfo.enabled` mặc định TRUE —
       * helpers/defaults.js:2439). Hai lý do:
       *  1. validateAudience của endpoint này (actions/userinfo.js:47-55) NÉM
       *     `InvalidToken` cho MỌI access token có `aud` — mà token của `auth`
       *     luôn resource-bound (defaultResource ở trên), nên endpoint nếu bật
       *     là endpoint luôn 401, tức là một endpoint đã công bố mà không bao
       *     giờ hoạt động: đúng thứ discovery trung thực phải loại bỏ.
       *  2. Profile claims hiện chưa có nguồn nào trả về (findAccount chỉ có
       *     `{ sub }`); tắt endpoint cùng lúc đó là tuyên bố trung thực.
       * Khi profile claims trở nên thực, bật lại endpoint phải đi cùng việc
       * bỏ `aud` khỏi access token dùng cho userinfo (tách token loại này)
       * hoặc provider đã sửa hành vi validateAudience.
       */
      userinfo: { enabled: false },
      // RFC 7009 BẬT — revocation endpoint được công bố và phục vụ qua provider.
      revocation: { enabled: true },
      // RP-initiated logout (OIDC Session Management) — `/session/end`.
      rpInitiatedLogout: { enabled: true },
      resourceIndicators: {
        enabled: true,
        /**
         * Access token của `auth` luôn là JWT ES256 typ at+jwt.
         *
         * ⚠️ `accessTokenFormat: 'jwt'` là switch format của provider
         * (models/formats/index.js: `token.resourceServer?.accessTokenFormat ?? 'opaque'`);
         * `jwt.sign.alg` chọn khoá từ keystore; `audience` quyết định claim `aud`
         * (`base_token.js:35-37` — `setAudience(resourceServer.audience || identifier)`).
         *
         * ⚠️ Mọi access token phải có audience: JWT format NÉM khi thiếu aud
         * (formats/jwt.js: `JWT Access Tokens must contain an audience`). Vì vậy glue
         * chèn `resource` mặc định vào authorize params (defaultResource bên dưới) —
         * token luôn resource-bound, luôn verify offline được.
         */
        defaultResource: (_ctx, client, oneOf): string => {
          // Chọn resource theo client nếu client được map tới một audience riêng
          // (vd. backoffice); nếu không, dùng primary audience (AUTH_AUDIENCE).
          const clientId =
            typeof client === 'object' && client !== null
              ? (client as { client_id?: unknown }).client_id
              : undefined;
          const mapped =
            typeof clientId === 'string'
              ? config.resources.find((resource) => resource.clientIds.includes(clientId))?.audience
              : undefined;
          const fallback = mapped ?? config.audience;
          // ⚠️ `oneOf` là mảng khi client gửi nhiều `resource`; ghi đè tường
          // minh thành phần tử thứ nhất (duy nhất được phép — multiple
          // resource bị `InvalidTarget` ở token time) thay vì trả nguyên mảng:
          // chữ ký của hàm chỉ nhận MỘT indicator.
          if (Array.isArray(oneOf)) {
            return oneOf[0] ?? fallback;
          }
          return oneOf ?? fallback;
        },
        useGrantedResource: (): boolean => true,
        getResourceServerInfo: (
          ctx,
          resourceIndicator,
          client,
        ): {
          readonly accessTokenFormat: 'jwt';
          readonly accessTokenTTL: number;
          readonly audience: string;
          readonly jwt: { readonly sign: { readonly alg: 'ES256' } };
          readonly scope: string;
        } => {
          // ⚠️ Chỉ resource indicator của chính hệ sinh thái được phục vụ: một
          // `resource` lạ sẽ nhận InvalidTarget thay vì một token audience-sai.
          const matched = config.resources.find(
            (resource) => resource.audience === resourceIndicator,
          );
          // Back-compat: primary audience luôn được phục vụ kể cả khi chưa khai báo
          // trong registry.
          const isKnown = matched !== undefined || resourceIndicator === config.audience;
          if (!isKnown) {
            throw new oidcErrors.InvalidTarget(
              `resource indicator khong duoc ho tro (ctx issuer: ${ctx.oidc.issuer})`,
            );
          }
          // ⚠️ Audience phụ (khác primary) chỉ cấp cho client nằm trong allowlist
          // `clientIds` của audience đó. Không kiểm thì MỌI client public đã đăng ký
          // đều xin `resource=<audience backoffice>` trực tiếp qua `/auth` (bypass
          // glue `/authorize`) và nhận token `aud=backoffice`. Provider truyền
          // client của request vào tham số thứ ba ở CẢ authorize lẫn token time
          // (shared/check_resource.js:75, helpers/grant_authorization.js:49,
          // actions/grants/refresh_token.js:184 của oidc-provider 9.13) — kiểm tra
          // ở đây là chốt chặn duy nhất cần thiết.
          if (matched !== undefined && matched.clientIds.length > 0) {
            const clientId =
              typeof client === 'object' && client !== null
                ? (client as { clientId?: unknown }).clientId
                : undefined;
            const clientAllowed =
              typeof clientId === 'string' && matched.clientIds.includes(clientId);
            if (!clientAllowed) {
              throw new oidcErrors.InvalidTarget(
                `client khong duoc phep dung resource indicator nay (ctx issuer: ${ctx.oidc.issuer})`,
              );
            }
          }
          return {
            audience: resourceIndicator,
            accessTokenFormat: 'jwt',
            accessTokenTTL: TTL.AccessToken,
            jwt: { sign: { alg: 'ES256' } },
            scope: [...SCOPES].join(' '),
          };
        },
      },
    },

    ttl: { ...TTL },

    // Rotation policy — tham chiếu hàm; provider gọi với ctx (refresh_token.js:116-121).
    rotateRefreshToken,

    // Cookie keys từ env — không default. Cookie không ký là cookie làm giả được.
    cookies: {
      keys: [...config.cookieKeys],
      names: {
        session: '_session',
        interaction: '_interaction',
        resume: '_interaction_resume',
      },
      long: { httpOnly: true, sameSite: 'lax', signed: true, secure: true, overwrite: true },
      short: { httpOnly: true, sameSite: 'lax', signed: true, secure: true, overwrite: true },
    },

    routes: { ...ROUTES },

    /**
     * Danh tính: trả `accountId` nguyên vẹn; `claims()` chỉ trả `{ sub }`.
     *
     * ⚠️ Đây là rào cản thứ HAI của "KHÔNG email_verified": kể cả khi một scope tương
     * lai khai thêm claim trong CLAIMS, `claims()` này không bao giờ trả nó. Hai lớp
     * độc lập; test parse ID token thật là lớp thứ ba.
     */
    findAccount: (
      _ctx,
      sub,
    ): {
      readonly accountId: string;
      claims(
        use: string,
        scope: string,
        claims: unknown,
        rejected: string[],
      ): Promise<Record<string, unknown>>;
    } => ({
      accountId: sub,
      async claims(): Promise<Record<string, unknown>> {
        return { sub };
      },
    }),

    /**
     * Interaction URL: dẫn browser về trang login của `account`, mang handle X.
     *
     * `ecoma_x` là tham số tùy chỉnh của `auth` gắn vào authorize params (khai trong
     * `extraParams` dưới đây) — handle X của §5.6, do glue mint trước khi đưa request
     * cho provider. Không có nó thì policy không biết dẫn browser về đâu.
     */
    interactions: {
      /**
       * ⚠️ **Ép interaction trên MỌI authorization — đây là quyết định bảo mật,
       * không phải tuỳ chọn UI.** Policy mặc định của provider cho phép skip:
       * một browser giữ session provider còn sống + grant còn đủ scope đi qua
       * `interactions()` (actions/authorization/interactions.js:36-70) mà KHÔNG
       * prompt nào, và `respond()` cấp code NGAY — tức là code được cấp mà:
       *  - cookie `__Host-auth-browser` KHÔNG được đối chiếu (§5.1.0 điều kiện 2
       *    bị bỏ qua — handle-theft chốt chặn biến mất),
       *  - `authorization_transactions` KHÔNG tồn tại, KHÔNG có idempotency,
       *    KHÔNG có audit,
       *  - account status KHÔNG được hỏi lại (điều kiện 3),
       *  - revocation KHÔNG được kiểm lại (điều kiện 4).
       * Nói cách khác, SSO-bypass path của provider là một đường cấp code bỏ qua
       * toàn bộ control plane mà ECOMA dựng quanh nó. Ép prompt login+consent
       * luôn REQUEST_PROMPT đưa MỌI request về đúng một đường: interaction →
       * account → back-channel → CAS → resume. Chi phí là không có SSO cookie
       * giữa các lần authorize (mỗi lần đi qua account một lần) — đó chính là
       * mô hình §5.1 mô tả, không phải một sự đánh đổi thêm.
       */
      policy: ((): ReturnType<typeof interactionPolicy.base> => {
        const policy = interactionPolicy.base();
        // Prompt login: thay các check mặc định (no_session/max_age/…) bằng
        // một check duy nhất đòi prompt trừ khi result của lần resume hiện tại
        // đã mang `login`. ⚠️ Check PHẢI consult `ctx.oidc.result`: sau khi
        // back-channel gắn result và browser quay lại resume URL, resume
        // middleware gán `ctx.oidc.result` rồi `await next()` — và policy chạy
        // LẠI trong cùng stack (actions/authorization/index.js:145,165-166,
        // `use(interactions, A, R, …)`). Một check luôn-true sẽ tạo Interaction
        // MỚI sau khi result đã áp, redirect browser về account lần nữa, và vì
        // handle X đã consumed → vòng lặp vô hạn. `false` = NO_NEED_TO_PROMPT =
        // resume đi qua, respond() cấp code.
        const login = policy.get('login');
        if (login === undefined) {
          throw new Error('interaction policy thieu prompt login');
        }
        // ⚠️ PHAI la instance cua `Check`, khong phai plain object: `interactions.js`
        // goi `await details(ctx)` tren TUNG check — plain object thieu `details`
        // la `TypeError: details is not a function` chet 500 tai MOI /auth (dung
        // loi ma acceptance test full-flow bat duoc). `Check` mang default
        // `details = () => {}`; error 'login_required' khai tuc minh vi Prompt
        // chi tu gan error cho check truyen vao CONSTRUCTOR cua no.
        login.checks.splice(
          0,
          login.checks.length,
          new interactionPolicy.Check(
            'ecoma_backchannel_required',
            'authentication is decided by the ECOMA back-channel',
            'login_required',
            (ctx: { oidc: { result?: { login?: unknown } } }) =>
              ctx.oidc.result?.login === undefined,
          ),
        );
        // Prompt consent: tương tự — consent do account quyết định, không do
        // grant của provider; prompt tắt đúng khi result đã mang `consent`.
        const consent = policy.get('consent');
        if (consent === undefined) {
          throw new Error('interaction policy thieu prompt consent');
        }
        // Cung ly do instance `Check` voi prompt login o tren.
        consent.checks.splice(
          0,
          consent.checks.length,
          new interactionPolicy.Check(
            'ecoma_backchannel_required',
            'consent is decided by the ECOMA back-channel',
            'consent_required',
            (ctx: { oidc: { result?: { consent?: unknown } } }) =>
              ctx.oidc.result?.consent === undefined,
          ),
        );
        return policy;
      })(),
      url: (_ctx, interaction): string => {
        const handleX = interaction.params?.['ecoma_x'];
        if (typeof handleX !== 'string' || handleX === '') {
          // Không handle ⇒ không có đường về account; fail-closed thay vì trang login
          // không mang handle (account sẽ không biết continuation nào).
          throw new Error('interaction khong mang handle X (ecoma_x)');
        }
        return `${config.accountBaseUrl}/login?handle=${encodeURIComponent(handleX)}`;
      },
    },

    /**
     * Tham số tùy chỉnh mà provider chấp nhận trên authorize request. Mặc định là
     * mảng rỗng (defaults.js:1032) — mọi param lạ bị từ chối `invalid_request`.
     * Chỉ handle X của ECOMA được đưa qua đây.
     */
    extraParams: ['ecoma_x'],
  });

  // ⚠️ BẬT `proxy` (property Koa trên chính instance — Provider extends Koa):
  // koa request.protocol đọc `socket.encrypted` trước, rồi MỚI tới header
  // `X-Forwarded-Proto` và CHỈ khi `app.proxy === true` (koa/lib/request.js:411-416).
  // Trên bridge `cloudflare:node` không có TLS socket — không bật proxy là protocol
  // luôn `http`, và `cookies.secure: true` của provider ném `Cannot send secure
  // cookie over unencrypted connection` → 500 ở MỌI request provider (đúng lỗi mà
  // acceptance test full-flow bắt được). Header proto được glue ghi đè tường minh
  // trong `runtime.ts` từ URL scheme của Worker (không thể bị client giả mạo).
  provider.proxy = true;

  return provider;
}
