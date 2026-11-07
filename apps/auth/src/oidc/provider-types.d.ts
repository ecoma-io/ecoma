/**
 * Khai báo kiểu tối giản cho `oidc-provider` 9.12.2.
 *
 * ⚠️ Vì sao file này tồn tại: `oidc-provider` KHÔNG ship types (`main` chỉ trỏ
 * `lib/index.js`), và `@types/oidc-provider` không thể thêm vào được — pnpm-lock.yaml
 * nằm ngoài phạm vi của công việc này. Không có khai báo thì mọi giá trị import từ lib
 * là `any` ngầm (TS7016), và mọi callback config trở thành hàm `any` không kiểm.
 *
 * ⚠️ Phạm vi của khai báo: CHỈ những surface mà `apps/auth` thực sự dùng
 * (`provider.ts`, `interaction.ts`, `main.ts`). Đây không phải bản cover toàn bộ API
 * của lib — phần chưa dùng được khai `unknown` thay vì bịa hình dạng. Khi code dùng
 * thêm surface mới, khai báo tương ứng được thêm ở đây, kèm tham chiếu file:line của
 * `lib/` để xác minh chứ không đoán.
 */

declare module 'oidc-provider' {
  /** Cookie của provider dạng Keygrip — mảng secret, phần tử đầu ký. */
  export type CookieKeygrip = readonly string[];

  /**
   * Kết quả một check của interaction policy: `REQUEST_PROMPT` (true) đòi
   * prompt, `NO_NEED_TO_PROMPT` (false) bỏ qua (helpers/interaction_policy/
   * check.js:23-24).
   */
  export type PolicyCheckResult = boolean | Promise<boolean>;

  /** Một check của policy — hình dạng Check của helpers/interaction_policy/check.js. */
  export interface PolicyCheck {
    readonly reason: string;
    readonly description: string;
    readonly error?: string;
    readonly check: (ctx: ProviderKoaContext) => PolicyCheckResult;
  }

  /** Một prompt của policy — helpers/interaction_policy/prompt.js. */
  export interface PolicyPrompt {
    readonly name: string;
    readonly requestable?: boolean;
    checks: PolicyCheck[];
    /**
     * Thay toàn bộ checks — dùng để ép một prompt luôn REQUEST_PROMPT
     * (checks.length === 1 và check luôn true).
     */
    removeAll?(): void;
    add(check: PolicyCheck, i?: number): void;
  }

  /**
   * `interactionPolicy.base()` — danh sách prompt mặc định (login, consent) với
   * các method mutation (helpers/interaction_policy/index.js:6-40). Cấu hình
   * nhận dạng mảng có thể được mutate TRƯỚC khi truyền vào Provider — provider
   * giữ tham chiếu (defaults.js:3341 `policy: defaultPolicy()`).
   */
  export interface InteractionPolicyBase extends Array<PolicyPrompt> {
    get(name: string): PolicyPrompt | undefined;
    remove(name: string): void;
    clear(): void;
    add(prompt: PolicyPrompt, i?: number): void;
  }

  /** Module namespace `interactionPolicy` — index.js export cuối của lib. */
  /** Error constructors của oidc-provider (helpers/errors.js). */
  export const errors: {
    InvalidTarget: new (
      description?: string,
      options?: unknown,
    ) => Error & { allow_redirect?: boolean };
  };

  export const interactionPolicy: {
    base(): InteractionPolicyBase;
    Check: new (
      reason: string,
      description: string,
      error?: string,
      check?: (ctx: ProviderKoaContext) => PolicyCheckResult,
    ) => PolicyCheck;
    Prompt: new (
      options: { name: string; requestable?: boolean },
      ...checks: PolicyCheck[]
    ) => PolicyPrompt;
  };

  /** Shape của một JWK — chỉ các trường keystore của provider đọc. */
  export interface JsonWebKey {
    readonly kty: string;
    readonly crv?: string;
    readonly x?: string;
    readonly y?: string;
    readonly d?: string;
    readonly kid?: string;
    readonly alg?: string;
    readonly use?: string;
    readonly n?: string;
    readonly e?: string;
  }

  /** `features.resourceIndicators.getResourceServerInfo` phải trả (resource_server.js). */
  export interface ResourceServerInfo {
    readonly audience?: string;
    readonly accessTokenFormat?: 'jwt' | 'opaque' | 'paseto';
    readonly accessTokenTTL?: number;
    readonly jwt?: { readonly sign?: { readonly alg?: string } };
    readonly scope?: string;
  }

  /** Entity mà `findAccount` trả — chỉ `accountId` + `claims()` được provider đọc. */
  export interface AccountClaims {
    readonly accountId: string;
    claims(
      use: string,
      scope: string,
      claims: unknown,
      rejected: string[],
    ): Promise<Record<string, unknown>>;
  }

  /** `ctx.oidc.entities` của provider — chỉ entity mà code này đọc. */
  export interface ProviderEntities {
    readonly RefreshToken?: { totalLifetime(): number };
  }

  /** Tối giản hoá `ctx.oidc` — những gì callbacks cấu hình đọc. */
  export interface OidcContextLite {
    readonly issuer: string;
    readonly entities: ProviderEntities;
    readonly session?: { readonly accountId?: string };
    /**
     * `result` mà resume middleware đã áp vào request hiện tại
     * (`actions/authorization/resume.js:96-99` gán `ctx.oidc.result` rồi mới
     * `await next()`), `undefined` trên lần vào `/auth` đầu tiên. Các check của
     * interaction policy PHẢI đọc trường này: sau khi resume áp result, policy
     * chạy LẠI trong cùng stack (`use(interactions, A, R, …)`) — một check
     * luôn-true sẽ tạo Interaction mới và đưa browser vào vòng lặp vô hạn.
     */
    readonly result?: InteractionResultInput;
  }

  /** `ctx` mà các callback cấu hình nhận — đủ để đọc `oidc`, không hơn. */
  export interface ProviderKoaContext {
    readonly oidc: OidcContextLite;
  }

  /** Payload của Interaction — các trường `IN_PAYLOAD` mà code này đụng tới. */
  export interface InteractionRef {
    readonly uid: string;
    readonly params?: Record<string, string | undefined>;
    readonly returnTo: string;
    readonly result?: InteractionResultInput;
  }

  /**
   * `result` set vào Interaction — hình dạng đọc lại tại `resume.js:98-108`:
   * `login` (`remember`, `accountId`, `ts`, `amr`, `acr`) và `consent`
   * (`grantId`), hoặc `error`/`error_description`.
   */
  export interface InteractionResultInput {
    readonly login?: {
      readonly remember?: boolean;
      readonly accountId: string;
      readonly ts?: number;
      readonly amr?: string[];
      readonly acr?: string;
    };
    readonly consent?: { readonly grantId: string };
    readonly error?: string;
    readonly error_description?: string;
    readonly [key: string]: unknown;
  }

  /** Model Grant của provider — những method glue dùng (`models/grant.js`). */
  export interface ProviderGrant {
    jti: string;
    accountId?: string;
    clientId?: string;
    addOIDCScope(scope: string | string[] | Set<string>): void;
    addOIDCClaims(claims: string | string[] | Set<string>): void;
    addResourceScope(resource: string, scope: string | string[] | Set<string>): void;
    save(ttl?: number): Promise<string>;
  }

  /** Model Interaction của provider (`models/interaction.js`). */
  export interface ProviderInteraction {
    readonly jti: string;
    readonly uid: string;
    readonly returnTo: string;
    readonly exp?: number;
    params?: Record<string, string | undefined>;
    result?: InteractionResultInput;
    save(ttl: number): Promise<string>;
    persist(): Promise<string>;
    destroy(): Promise<void>;
  }

  /** Model Session của provider. */
  export interface ProviderSession {
    readonly jti: string;
    readonly uid: string;
  }

  /**
   * Adapter contract — mọi method từ `memory_adapter.js` trừ những cái provider
   * chỉ gọi khi feature tương ứng bật.
   */
  export interface ProviderAdapter {
    upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<unknown>;
    find(id: string): Promise<Record<string, unknown> | undefined>;
    findByUid(uid: string): Promise<Record<string, unknown> | undefined>;
    findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined>;
    consume(id: string): Promise<unknown>;
    destroy(id: string): Promise<unknown>;
    revokeByGrantId(grantId: string): Promise<unknown>;
  }

  export interface ProviderConfiguration {
    readonly adapter?: unknown;
    readonly jwks?: { readonly keys: readonly JsonWebKey[] };
    readonly responseTypes?: readonly string[];
    readonly grantTypes?: readonly string[];
    readonly scopes?: readonly string[];
    /** scope → claim name, hoặc claim name → `null` (mặc định luôn cấp). */
    readonly claims?: Record<string, readonly string[] | null>;
    readonly pkce?: { readonly required?: boolean; readonly methods?: readonly string[] };
    readonly features?: {
      readonly devInteractions?: { readonly enabled: boolean };
      readonly claimsParameter?: { readonly enabled: boolean };
      readonly introspection?: { readonly enabled: boolean };
      readonly revocation?: { readonly enabled: boolean };
      readonly rpInitiatedLogout?: { readonly enabled: boolean };
      readonly userinfo?: { readonly enabled: boolean };
      readonly resourceIndicators?: {
        readonly enabled: boolean;
        readonly defaultResource?: (
          ctx: ProviderKoaContext,
          client: unknown,
          oneOf?: string | string[],
        ) => string | undefined | Promise<string | undefined>;
        readonly useGrantedResource?: (
          ctx: ProviderKoaContext,
          client: unknown,
          resource?: string[],
        ) => boolean | Promise<boolean>;
        readonly getResourceServerInfo?: (
          ctx: ProviderKoaContext,
          resourceIndicator: string,
          client: unknown,
        ) => ResourceServerInfo | Promise<ResourceServerInfo>;
      };
    };
    /** TTL theo model class — giây, hoặc hàm `(ctx, model) => seconds`. */
    readonly ttl?: Record<string, number>;
    readonly rotateRefreshToken?:
      | boolean
      | ((ctx: { readonly oidc: ProviderKoaContext['oidc'] }) => boolean | Promise<boolean>);
    readonly cookies?: {
      readonly keys: CookieKeygrip;
      readonly names?: Partial<Record<'session' | 'interaction' | 'resume', string>>;
      readonly long?: Record<string, unknown>;
      readonly short?: Record<string, unknown>;
    };
    readonly routes?: Partial<
      Record<
        | 'authorization'
        | 'token'
        | 'userinfo'
        | 'jwks'
        | 'revocation'
        | 'end_session'
        | 'introspection',
        string
      >
    >;
    readonly findAccount?: (
      ctx: ProviderKoaContext,
      sub: string,
      token?: unknown,
    ) => AccountClaims | Promise<AccountClaims>;
    readonly interactions?: {
      /**
       * `policy` của provider — base() của interaction_policy, được glue mutate
       * để ép interaction trên MỌI authorization (SSO bypass là lỗ hổng: nó cấp
       * code bỏ qua bốn điều kiện §5.1.0).
       */
      readonly policy?: InteractionPolicyBase;
      readonly url?: (
        ctx: ProviderKoaContext,
        interaction: InteractionRef,
      ) => string | Promise<string>;
    };
    readonly extraParams?: readonly string[];
    readonly conformIdTokenClaims?: boolean;
    readonly clockTolerance?: number;
    readonly enabledJWA?: unknown;
    [key: string]: unknown;
  }

  /**
   * Provider — chỉ những thành viên `apps/auth` gọi. `Koa` được ném vào `unknown`
   * vì bridge (`handleAsNodeRequest`) không cần surface class của nó: chỉ
   * `createServer(provider.callback())` của `node:http` dùng nó như một hàm
   * `(req, res) => void`.
   */
  export class Provider {
    constructor(issuer: string, configuration?: ProviderConfiguration);
    readonly issuer: string;
    /**
     * Property Koa trên chính instance (Provider extends Koa, provider.js:29):
     * `true` cho phép request.protocol đọc `X-Forwarded-Proto`
     * (koa/lib/request.js:411-416) — bridge `cloudflare:node` không có TLS
     * socket nên đây là con đường DUY NHẤT để provider thấy protocol thật;
     * glue ghi đè header này trong `runtime.ts` từ URL scheme của Worker.
     */
    proxy: boolean;
    /** `(req, res) => void` cho `http.createServer` (koa `application.js:167-183`). */
    callback(): (req: unknown, res: unknown) => void;
    /** Bật listener — chỉ cần cho `handleAsNodeRequest` biết port. */
    listen(port: number, callback?: () => void): unknown;
    address(): { readonly port?: number | null } | null;
    /** Model constructors/getters — glue dùng để dựng và tra artifact. */
    get Grant(): (new (payload?: Record<string, unknown>) => ProviderGrant) & {
      find(id: string): Promise<ProviderGrant | undefined>;
    };
    get Interaction(): (new (
      jti: string,
      payload?: Record<string, unknown>,
    ) => ProviderInteraction) & {
      find(id: string): Promise<ProviderInteraction | undefined>;
    };
    get Session(): {
      find(id: string): Promise<ProviderSession | undefined>;
      findByUid(uid: string): Promise<ProviderSession | undefined>;
    };
    /**
     * `interactionResult`/`interactionFinished` đòi Node req/res có cookie
     * `interaction` (`provider.js:426-450`) — back-channel ECOMA không có
     * cookie đó nên glue thao tác Interaction trực tiếp, không qua hai hàm này.
     */
    interactionResult(
      req: unknown,
      res: unknown,
      result: InteractionResultInput,
      options?: { readonly mergeWithLastSubmission?: boolean },
    ): Promise<string>;
    interactionFinished(
      req: unknown,
      res: unknown,
      result: InteractionResultInput,
      options?: { readonly mergeWithLastSubmission?: boolean },
    ): Promise<void>;
    /** Event emitter của Koa — glue đăng ký hook qua đây. */
    on(event: string, listener: (...args: never[]) => void): this;
    once(event: string, listener: (...args: never[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
  }

  /** Nhánh mặc định của module — `import Provider from 'oidc-provider'`. */
  export default Provider;
}

/**
 * `ExecutionContext` của Workers — mirror của `@cloudflare/workers-types`
 * (`experimental/index.d.ts:487`). apps/auth khai `types: ["node"]` nên ambient
 * types của workers-types KHÔNG được nạp; interface tối thiểu mà glue đọc:
 * chỉ `waitUntil` (kéo dài vòng đời promise sau response).
 */
interface ExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
}

/**
 * `cloudflare:node` — mirror của `@cloudflare/workers-types` experimental
 * (`experimental/index.d.ts:16378-16418`). apps/auth khai `types: ["node"]`
 * trong tsconfig nên workers-types experimental không được nạp; khai báo
 * tối thiểu những gì glue dùng: server Node-style + cầu `Request` Web →
 * handler Node. Runtime chỉ khả dụng trên workerd với `nodejs_compat`
 * (wrangler.jsonc đã bật) — workerd-native build sẽ fail nếu module thiếu.
 */
declare module 'cloudflare:node' {
  /**
   * Server Node-style: `listen()` nhận mọi overload của `node:http`
   * (ở đây dùng `listen(0)` — port ephemeral ngẫu nhiên), `address()` trả
   * `{ port }` sau khi listen, `null` trước đó.
   */
  export interface NodeStyleServer {
    listen(...args: unknown[]): this;
    address(): { port?: number | null | undefined } | null;
  }

  /**
   * Cầu một `Request` Web API vào server Node đang listen: biến request
   * thành req/res Node, chạy qua toàn bộ pipeline Koa, rồi gói response
   * Node thành `Response` Web. `env`/`ctx` được gắn vào lifecycle của
   * request để I/O Node giữ đúng ngữ cảnh Workers.
   */
  export function handleAsNodeRequest(
    port: number | { port: number } | NodeStyleServer,
    request: Request,
    env?: unknown,
    ctx?: ExecutionContext,
  ): Promise<Response>;

  export function httpServerHandler(
    port: number | { port: number } | NodeStyleServer,
  ): ExportedHandler;
  export function connectHandler(): ExportedHandler;
  export function handleAsNodeConnection(
    socket: unknown,
    env?: unknown,
    ctx?: Pick<ExecutionContext, 'waitUntil'>,
  ): Promise<void>;
}
