/**
 * `AccountClient` — consumer của `GET /internal/account/status` (issue #208).
 *
 * ## Vì sao test này tồn tại
 *
 * Hai phía từng dùng hai tên tham số khác nhau cho cùng một định danh: consumer gửi
 * `?account_id=`, provider đọc `query.sub` rồi `isSubject` nó. Không test nào đỏ, vì
 * **không test nào nhìn vào URL thật** mà client dựng ra: suite cũ chỉ kiểm nhánh trả lời
 * của `#send` (500/503/body sai), và cả ba nhánh đó đều đúng ngay cả khi query parameter
 * sai — provider trả `400` cho một request ký hoàn hảo mà thiếu `sub`, và client coi đó là
 * "Account trả lỗi", tức fail-closed che mất lỗi contract.
 *
 * Vì vậy test ở đây giữ **Request thật** mà binding nhận, không đọc chuỗi trong file:
 * một assert trên source (`toMatch(/sub=/)`) vẫn xanh khi URL được ghép từ hai mảnh hay
 * khi `encodeURIComponent` đổi thứ tự, còn capture ở đây thì không.
 *
 * ⚠️ `verifyRequest` được dùng ở đây là **hàm canonical thật** của
 * `@ecoma-io/auth-contracts`, không phải một bản chép: chữ ký trong test được kiểm
 * bằng đúng đoạn code mà `account` chạy trong middleware internal-auth.
 *
 * ⚠️ Test cuối file đọc source của provider. Đó là **drift detector**, không phải một
 * lần chạy provider thật — xem JSDoc của chính test đó để biết nó chứng minh được gì và
 * không chứng minh được gì.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  verifyRequest,
} from '@ecoma-io/auth-contracts';

import { AccountClient, type AccountServiceBinding } from './account-client';

/** Secret hợp lệ cho test — không phải secret thật, chỉ để ký/verify. */
const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/**
 * `accountId` của người gọi — và trong nghiệp vụ thật nó **là subject**.
 *
 * `authorization-service.completeAuthorization` đặt thẳng `claims.sub = params.accountId`
 * khi phát access token, nên giá trị dưới đây là một `sub` hợp lệ theo `isSubject`
 * (`sub_` + 32 ký tự base32). Test dùng đúng dạng đó để một ngày nào đó provider kiểm
 * `isSubject` ở phía consumer thì suite này không xanh vì lý do sai.
 */
const CALLER_ACCOUNT_ID = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Path canonical của contract — provider đọc `query.sub` (xem `status.get.ts`). */
const CANONICAL_PATH = '/internal/account/status';

/**
 * Source của provider, để test conformance cuối file đọc ra tên tham số **nó** đọc.
 *
 * Đường dẫn tương đối từ `apps/auth/src/` tới `apps/account/`: `../../account/…`.
 * Spec đọc file thật bằng `node:fs` là chuyện đã có trong repo (xem
 * `internal-auth.spec.ts` đọc source của lib) — và nó là cách duy nhất ở đây: ranh giới
 * `type:composition` của Nx **cấm** app này import app kia, nên không có đường "gọi thật
 * provider" nào từ phía `auth`.
 */
const PROVIDER_ROUTE_SOURCE = join(
  import.meta.dirname,
  '../../account/server/routes/internal/account/status.get.ts',
);

/** Một Request đã được gửi qua binding, cùng `init` đi kèm. */
interface CapturedCall {
  readonly request: Request;
  readonly init: RequestInit | undefined;
}

/**
 * Binding giả ghi lại mọi request, trả response do test chỉ định.
 *
 * ⚠️ `fetch` nhận `(input, init)` theo đúng chữ ký `AccountServiceBinding` — nếu binding
 * thật chỉ được gọi bằng `fetch(request)` thì test này sẽ không bắt được việc timeout bị
 * bỏ, và đó là lý do `init` cũng được giữ lại.
 */
function capturingBinding(respond: (call: CapturedCall) => Response | Promise<Response>): {
  binding: AccountServiceBinding;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  return {
    calls,
    binding: {
      fetch: async (input, init) => {
        const call: CapturedCall = { request: input, init };
        calls.push(call);
        return respond(call);
      },
    },
  };
}

/** Response JSON 200 như provider thật trả cho một `sub` hợp lệ. */
function statusResponse(status: string): Response {
  return new Response(JSON.stringify({ status }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Lần gọi duy nhất đã xảy ra — ném khi số lần gọi không phải một. */
function onlyCall(calls: readonly CapturedCall[]): CapturedCall {
  if (calls.length !== 1) {
    throw new Error(`mong đợi đúng một lần gọi Account, đo được ${calls.length}`);
  }
  const [call] = calls;
  if (call === undefined) {
    throw new Error('không có lần gọi nào');
  }
  return call;
}

/** Ba header envelope của một request đã gửi, đúng kiểu `verifyRequest` nhận. */
function envelopeHeaders(request: Request): Record<string, string | null> {
  return {
    [INTERNAL_TIMESTAMP_HEADER]: request.headers.get(INTERNAL_TIMESTAMP_HEADER),
    [INTERNAL_NONCE_HEADER]: request.headers.get(INTERNAL_NONCE_HEADER),
    [INTERNAL_SIGNATURE_HEADER]: request.headers.get(INTERNAL_SIGNATURE_HEADER),
  };
}

describe('AccountClient.checkStatus — the query parameter on the wire', () => {
  it('calls the canonical path with the `sub` parameter, and signs exactly the request it sends', async () => {
    const { binding, calls } = capturingBinding(() => statusResponse('active'));
    const client = new AccountClient({ binding, secret: SECRET });

    await expect(
      client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() }),
    ).resolves.toBe('active');

    const { request } = onlyCall(calls);
    const url = new URL(request.url);

    expect(request.method).toBe('GET');
    // ⚠️ Hai assert dưới đây là chốt chống tái phát của #208, và chúng ghim **giá trị
    // cụ thể** chứ không chỉ "có một tham số nào đó": đổi tên tham số ở consumer là đỏ,
    // kể cả khi đổi thành một tên khác cũng có một phần tử.
    expect(url.pathname).toBe(CANONICAL_PATH);
    expect(url.search).toBe(`?sub=${CALLER_ACCOUNT_ID}`);
    // Mặt đối: tên của bản lỗi không được có mặt ở bất kỳ dạng nào (kể cả như một
    // tham số thứ hai đi kèm).
    expect([...url.searchParams.keys()]).toEqual(['sub']);
    expect(request.url).not.toContain('account_id');

    // Chữ ký phải verify được bằng hàm canonical, trên **đúng** method và **đúng**
    // path đã gửi (path + query như trên dây). Đây là bất biến "ký cái gì gửi cái đó".
    const timestamp = request.headers.get(INTERNAL_TIMESTAMP_HEADER) ?? '';
    const verification = await verifyRequest({
      method: request.method,
      path: url.pathname + url.search,
      body: new Uint8Array(),
      headers: envelopeHeaders(request),
      secret: SECRET,
      now: timestamp,
      claimNonce: () => false,
    });
    expect(verification.ok).toBe(true);
  });

  it('rejects reusing a signature for another URL — `bad_signature`, not acceptance', async () => {
    // ⚠️ Đây là lỗi mà §4.1 của task cấm: dựng chữ ký cho một URL rồi gọi URL khác.
    // Envelope dưới đây là envelope **thật** sinh ra cho `?sub=…`; đem nó đi verify trên
    // `?account_id=…` phải ra `bad_signature`, chứ không phải một lần chấp nhận. Nếu
    // không có assert này, một bản cài đặt "ký path A, gửi path B" chỉ đỏ ở provider —
    // tức ở môi trường tích hợp, chứ không ở unit test của consumer.
    const { binding, calls } = capturingBinding(() => statusResponse('active'));
    const client = new AccountClient({ binding, secret: SECRET });
    await client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() });

    const { request } = onlyCall(calls);
    const timestamp = request.headers.get(INTERNAL_TIMESTAMP_HEADER) ?? '';
    const verification = await verifyRequest({
      method: 'GET',
      path: `${CANONICAL_PATH}?account_id=${CALLER_ACCOUNT_ID}`,
      body: new Uint8Array(),
      headers: envelopeHeaders(request),
      secret: SECRET,
      now: timestamp,
      claimNonce: () => false,
    });

    expect(verification).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('signs the GET method — no other method can reuse the envelope', async () => {
    // Bất biến "ký đúng method": nếu method không tham gia chuỗi ký thì envelope của
    // một lần đọc trạng thái dùng lại được cho một request có thân, và điều đó chỉ lộ ra
    // ở provider. Assert ở đây giữ nó ngay tại consumer.
    const { binding, calls } = capturingBinding(() => statusResponse('active'));
    const client = new AccountClient({ binding, secret: SECRET });
    await client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() });

    const { request } = onlyCall(calls);
    const url = new URL(request.url);
    const verification = await verifyRequest({
      method: 'POST',
      path: url.pathname + url.search,
      body: new Uint8Array(),
      headers: envelopeHeaders(request),
      secret: SECRET,
      now: request.headers.get(INTERNAL_TIMESTAMP_HEADER) ?? '',
      claimNonce: () => false,
    });

    expect(verification).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('calls exactly once, carries a timeout, and never retries under another parameter name', async () => {
    // ⚠️ "Không fallback sang tên tham số thứ hai" (§4.1) chỉ kiểm được bằng **số lần
    // gọi**: một bản cài đặt thử `?sub=` rồi thử `?account_id=` khi gặp 400 vẫn trả về
    // một lỗi đúng loại, nên không assert nào về giá trị trả lại phân biệt được nó với
    // bản đúng. Provider trả 400 ở đây chính là câu trả lời mà một lần thử lại sẽ gặp.
    const { binding, calls } = capturingBinding(
      () => new Response('', { status: 400, statusText: 'Bad Request' }),
    );
    const client = new AccountClient({ binding, secret: SECRET });

    await expect(
      client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() }),
    ).rejects.toThrow(/400/u);

    expect(calls).toHaveLength(1);
    expect(onlyCall(calls).request.url).toBe(
      `https://account.internal${CANONICAL_PATH}?sub=${CALLER_ACCOUNT_ID}`,
    );
    // Timeout đi qua `init.signal`: Service Binding không có socket timeout mặc định,
    // nên mất signal là mất luôn giới hạn treo request.
    expect(onlyCall(calls).init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 401, 500, 503])(
    'throws when Account answers %i — never returns a status',
    async (status) => {
      // Fail-closed: mọi mã lỗi đều thành "không phát hành". Không nhánh nào ở đây được
      // trả `not_found` hay một giá trị mặc định — đó là biến lỗi hạ tầng thành quyết
      // định nghiệp vụ.
      const { binding, calls } = capturingBinding(() => new Response('', { status }));
      const client = new AccountClient({ binding, secret: SECRET });

      await expect(
        client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() }),
      ).rejects.toThrow(new RegExp(String(status), 'u'));
      expect(calls).toHaveLength(1);
    },
  );

  it('throws when the body is not JSON, returning no default status', async () => {
    const { binding } = capturingBinding(
      () =>
        new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const client = new AccountClient({ binding, secret: SECRET });

    await expect(
      client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() }),
    ).rejects.toThrow(/khong phai JSON/u);
  });

  it.each([
    ['missing the status field', {}],
    ['status outside the allowlist', { status: 'ACTIVE' }],
    ['status is an unknown value', { status: 'pending_review' }],
    ['status is not a string', { status: 200 }],
  ])(
    'throws when the provider returns a body outside the contract (%s)',
    async (_label, payload) => {
      // Allowlist của contract là bốn giá trị. Một `status` lạ không được coi như "không
      // rõ" rồi cho qua: tầng trên đọc nó như một câu trả lời.
      const { binding } = capturingBinding(
        () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = new AccountClient({ binding, secret: SECRET });

      await expect(
        client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() }),
      ).rejects.toThrow(/allowlist/u);
    },
  );

  it('propagates a binding failure (Account unreachable) — throws, returns no status', async () => {
    const binding: AccountServiceBinding = {
      fetch: () => Promise.reject(new Error('connection refused')),
    };
    const client = new AccountClient({ binding, secret: SECRET });

    await expect(
      client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() }),
    ).rejects.toThrow(/connection refused/u);
  });
});

/**
 * Tên tham số mà provider **đọc** ra khỏi query, lấy từ source của route.
 *
 * Bỏ dòng comment trước khi match để một câu văn nhắc `query.foo` không tự biến thành
 * một tham số thứ hai. Comment ở **cuối** một dòng code vẫn được quét — và đó là chiều
 * fail-loud: nếu nó sinh ra một tên lạ, assert `size === 1` dưới đây đỏ và người sửa
 * phải quyết định, thay vì im lặng bỏ qua.
 */
function providerQueryParameters(source: string): Set<string> {
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
  const names = [...code.matchAll(/\bquery\.([A-Za-z_$][\w$]*)/gu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  return new Set(names);
}

describe('consumer/provider conformance — one shared parameter name', () => {
  it('the consumer sends the parameter name the provider reads — a one-sided change turns red', async () => {
    // ## Test này chứng minh được gì, và không chứng minh được gì
    //
    // ⚠️ Ranh giới `type:composition` của Nx cấm `auth` import `account` (và ngược lại),
    // nên không có test nào trong repo chạy được **cả hai** phía trong một process. Đây là
    // mức gần nhất mà không phá ranh giới:
    //
    // - Giá trị của consumer được **đo lúc chạy** (Request thật mà binding nhận), không
    //   phải đọc từ source.
    // - Giá trị của provider được **đọc từ source** của route — nên test này KHÔNG chứng
    //   minh provider hành xử đúng như source nói. Phần đó do
    //   `apps/account/tests/integrations/status-route-e2e.spec.ts` chứng minh: nó chạy
    //   handler thật với `?sub=` (200) và với `?account_id=` (400).
    //
    // Ghép hai thứ lại mới là bằng chứng compatibility: consumer gửi `X` (đo), provider
    // đọc `X` (suy từ source) và phục vụ `X` (đo ở suite kia).
    //
    // Vì sao vẫn cần test này dù mỗi phía đã có assert literal riêng: đây là test duy nhất
    // **không thể** sửa bằng cách sửa một phía. Ai đổi tên tham số ở provider mà quên
    // consumer (hoặc ngược lại) sẽ đỏ ở đây, kể cả khi cả hai suite kia vẫn xanh vì mỗi
    // bên đang tự nhất quán với chính mình.
    const providerReads = providerQueryParameters(readFileSync(PROVIDER_ROUTE_SOURCE, 'utf8'));

    const { binding, calls } = capturingBinding(() => statusResponse('active'));
    const client = new AccountClient({ binding, secret: SECRET });
    await client.checkStatus({ accountId: CALLER_ACCOUNT_ID, nowMs: Date.now() });

    const consumerSends = new Set(new URL(onlyCall(calls).request.url).searchParams.keys());

    // Provider đọc đúng MỘT tham số. Từ hai trở lên là một quyết định contract (alias,
    // hoặc param thứ hai) chứ không phải một lần refactor — và task #208 cấm nhận alias,
    // nên nó phải đỏ ở đây để người sửa nhìn thấy.
    expect(providerReads.size).toBe(1);
    expect([...consumerSends].toSorted()).toEqual([...providerReads].toSorted());
  });
});
