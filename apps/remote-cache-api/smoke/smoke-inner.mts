/**
 * Smoke real-storage của `remote-cache-api-deploy` — inner (chạy TRONG container
 * gắn platform network), được ĐẶT CÙNG app để import được class S3 thật.
 *
 * Vì sao file nằm trong `apps/remote-cache-api/smoke/`: script import trực tiếp
 * `S3ObjectStorage` từ `../src/storage` — client THẬT mà worker dùng lúc
 * runtime. Ranh giới module (`@nx/enforce-module-boundaries`) cấm edge
 * `type:deployment → type:composition`, nên file KHÔNG thể nằm trong
 * `deploys/remote-cache-api-deploy`; composition tự import chính nó là hợp lệ
 * (quyết định của coordinator trong follow-up của slice remote-cache local
 * deployment). File KHÔNG thuộc bundle Worker: `wrangler` chỉ bundle từ
 * `src/main.ts`, file không được reference từ nguồn nào của app; nó được chạy
 * bằng `npx tsx` trong image Node pin (cùng digest với WIC — `node-image.ts` của
 * deploy unit) qua `deploys/remote-cache-api-deploy/smoke.ts`.
 *
 * Hai mắt kiểm chứng storage + hai mắt control-plane (#20):
 * 1. `GET /ready` của worker qua alias DNS `ecoma-remote-cache-api` (dev.port
 *    4207 của `wrangler.jsonc`) phải báo `database: 'ok'` VÀ
 *    `storage: 'configured'` — bốn biến env `S3_*` + secret đã đến tay worker
 *    qua kênh `envs` của WIC và `src/config.ts` nạp được bộ config đó.
 * 2. Round-trip object THẬT trên bucket SeaweedFS của platform (issue #19) qua
 *    chính client của app: `putIfAbsent` → `'created'`; `get` byte-equal;
 *    `putIfAbsent` trùng → `'exists'`; `get` key chưa viết → `null`.
 * 3. Control-plane + data-plane E2E qua HTTP thật của worker (#20): tenant
 *    canonical `ecoma` đã bootstrap (GET /projects bằng first trusted CI key
 *    thấy project `ecoma-ci`), POST /projects bằng key đó → 201 + token
 *    show-once, PUT /v1/cache/:hash → 201, GET → 200 byte-equal, PUT trùng
 *    hash → 409 (immutability).
 * 4. Cleanup KHÔNG thêm op delete vào port của app: script tự ký request S3
 *    DELETE SigV4 dưới đây (minimal, body rỗng — dạng ký mà `storage.ts`
 *    chứng minh: service `s3`, region từ options, URL path-style,
 *    `x-amz-content-sha256` của payload rỗng) cho object smoke VÀ cho object
 *    cache E2E, assert 2xx, rồi `get` lại → `null`.
 *
 * Secret đọc từ fd 0 (stdin) dạng MỘT envelope JSON
 * `{"objectStorageSecretKey":"…","ciKeyPlaintext":"…"}` — giá trị đến từ outer
 * qua `docker run -i`, không qua argv/-e/label/log. Script không bao giờ in giá
 * trị secret và không bao giờ in header `authorization` ký đầy đủ.
 *
 * Lưu ý lint: block override `apps/remote-cache-api/smoke/` trong root
 * `.oxlintrc.json` tắt `no-console`/cấm Node builtin CHO RIÊNG thư mục này —
 * script là tooling Node-only (chạy trên Node runner, không được bundle vào
 * edge), cùng tính chất với block exemption của thư mục db/ của các app ngay
 * trên nó.
 */

import { randomBytes } from 'node:crypto';

import { S3ObjectStorage } from '../src/storage';

/** Worker alias + dev.port (wrangler.jsonc) — hằng số giống deploy của chính unit. */
const READY_URL = 'http://ecoma-remote-cache-api:4207/ready';

/** Hash SHA-256 của payload rỗng — ký cho DELETE của cleanup. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Tham số của request DELETE — cùng shape `S3StorageConfig` của `storage.ts`. */
interface S3RawRequest {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

/** Đọc toàn bộ fd 0 (stdin) tới EOF — secret đến qua stdin, không ở nơi khác. */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** Kéo toàn bộ body stream thành một buffer (dùng để so sánh byte). */
async function drainBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ----- SigV4 (dạng ký xác thực của storage.ts, sao chép chính xác shape) -----

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function hmacSha256Bytes(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function hmacSha256HexBytes(key: ArrayBuffer, message: string): Promise<string> {
  const sig = await hmacSha256Bytes(key, message);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** URL path-style của object — sao chép `objectUrl` của `storage.ts`. */
function objectUrl(config: S3RawRequest, key: string): URL {
  const base = config.endpoint.replace(/\/+$/u, '');
  return new URL(`${base}/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
}

/**
 * Ký một request DELETE path-style có body rỗng, gửi qua fetch và trả về status
 * HTTP. Header `Authorization` mang secret — KHÔNG BAO GIỜ được in ra log.
 */
async function signDeleteAndDispatch(config: S3RawRequest, key: string): Promise<number> {
  const url = objectUrl(config, key);
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': EMPTY_SHA256,
  };
  const signedHeadersList = Object.keys(headers).toSorted();
  const canonicalHeaders = signedHeadersList.map((h) => `${h}:${headers[h] ?? ''}\n`).join('');
  const canonicalRequest = [
    'DELETE',
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeadersList.join(';'),
    EMPTY_SHA256,
  ].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = await hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256Bytes(kDate, config.region);
  const kService = await hmacSha256Bytes(kRegion, service);
  const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
  const signature = await hmacSha256HexBytes(kSigning, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList.join(';')}, Signature=${signature}`;
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: { ...headers, authorization },
  });
  return res.status;
}

// ----- Assertions -----------------------------------------------------------

const failures: string[] = [];
function pass(label: string): void {
  console.log(`PASS: ${label}`);
}
function fail(label: string): void {
  failures.push(label);
  console.log(`FAIL: ${label}`);
}
function check(condition: boolean, label: string): void {
  if (condition) pass(label);
  else fail(label);
}

/** Một luồng một lần dùng chứa `payload` — đúng kiểu body của `putIfAbsent`. */
function bodyStream(payload: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.enqueue(payload);
      controller.close();
    },
  });
}

async function main(): Promise<void> {
  // 1. /ready của worker qua alias DNS nội bộ — đường qua config thật của app;
  //    body JSON không chứa secret.
  try {
    const res = await fetch(READY_URL);
    const readyBody = (await res.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    check(res.status === 200, `GET ${READY_URL} returns 200 (got ${String(res.status)})`);
    check(
      readyBody?.database === 'ok',
      `/ready reports database ok (got ${JSON.stringify(readyBody?.database)})`,
    );
    check(
      readyBody?.storage === 'configured',
      `/ready reports storage configured (got ${JSON.stringify(readyBody?.storage)})`,
    );
  } catch (error) {
    fail(
      `${READY_URL} reachable and returns JSON (error: ${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // 2. Secrets từ fd 0 — envelope JSON với HAI secret, parse fail-closed.
  const envelopeRaw = await readAllStdin();
  let objectStorageSecret = '';
  let ciKeyPlaintext = '';
  try {
    const parsed: unknown = JSON.parse(envelopeRaw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record['objectStorageSecretKey'] === 'string') {
        objectStorageSecret = record['objectStorageSecretKey'];
      }
      if (typeof record['ciKeyPlaintext'] === 'string') {
        ciKeyPlaintext = record['ciKeyPlaintext'];
      }
    }
  } catch {
    // Envelope không phải JSON — fail bên dưới với message cố định, không in raw.
  }
  check(objectStorageSecret.length > 0, 'object storage secret received on stdin');
  check(ciKeyPlaintext.length > 0, 'CI key plaintext received on stdin');

  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  check(
    typeof endpoint === 'string' && endpoint.length > 0,
    'S3_ENDPOINT present in container env',
  );
  check(typeof bucket === 'string' && bucket.length > 0, 'S3_BUCKET present in container env');
  check(
    typeof accessKeyId === 'string' && accessKeyId.length > 0,
    'S3_ACCESS_KEY_ID present in container env',
  );

  if (
    failures.length > 0 ||
    objectStorageSecret.length === 0 ||
    typeof endpoint !== 'string' ||
    typeof bucket !== 'string' ||
    typeof accessKeyId !== 'string'
  ) {
    console.error(
      `SMOKE FAILED: ${failures.length} assertion(s) failed before storage round trip.`,
    );
    process.exitCode = 1;
    return;
  }

  // Client S3 THẬT của app — options như `buildStorage` của `src/cache-routes.ts`
  // dựng từ config.ts (region 'auto' hardcode ở đó).
  const storage = new S3ObjectStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey: objectStorageSecret,
    region: 'auto',
  });

  // 3. Vòng đời object thật: tạo mới → đọc → trùng → đọc key chưa từng viết.
  const key = `smoke/${Date.now()}-${randomBytes(8).toString('hex')}`;
  const payload = new TextEncoder().encode(`ecoma remote-cache real-storage smoke ${key}`);

  const put = await storage.putIfAbsent(key, bodyStream(payload), payload.byteLength, 'text/plain');
  check(put === 'created', `putIfAbsent on a fresh key returns 'created' (got ${String(put)})`);

  const got = await storage.get(key);
  check(got !== null, 'get returns the freshly written object');
  if (got !== null) {
    const gotBytes = await drainBody(got.body);
    check(
      Buffer.from(gotBytes).equals(Buffer.from(payload)),
      `get body is byte-equal to the written payload (${gotBytes.byteLength} vs ${payload.byteLength} bytes)`,
    );
  }

  const putAgain = await storage.putIfAbsent(
    key,
    bodyStream(payload),
    payload.byteLength,
    'text/plain',
  );
  check(
    putAgain === 'exists',
    `putIfAbsent on the same key returns 'exists' (got ${String(putAgain)})`,
  );

  const miss = await storage.get(`smoke/never-written-${randomBytes(8).toString('hex')}`);
  check(miss === null, 'get of a never-written key returns null');

  // 3b. Control-plane + data-plane E2E (#20) — đường HTTP thật của worker, bằng
  // first trusted CI key mà bootstrap đã cấp (plaintext từ envelope stdin).
  const baseUrl = 'http://ecoma-remote-cache-api:4207';
  const bootstrapAuth = { authorization: `Bearer ${ciKeyPlaintext}` };

  const listRes = await fetch(`${baseUrl}/projects`, { headers: bootstrapAuth });
  check(
    listRes.status === 200,
    `GET /projects with the bootstrap CI key returns 200 (got ${String(listRes.status)})`,
  );
  const listBody = (await listRes.json().catch(() => undefined)) as
    | { projects?: Array<{ name?: unknown }> }
    | undefined;
  check(
    Array.isArray(listBody?.projects) &&
      listBody.projects.some((p) => (p as { name?: unknown } | null)?.name === 'ecoma-ci'),
    'GET /projects shows the bootstrap host project ecoma-ci (tenant canonical exists)',
  );

  const projectName = `smoke-e2e-${Date.now()}`;
  const createRes = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { ...bootstrapAuth, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: projectName,
      api_key_scopes: ['read', 'write'],
      trusted_ci: true,
    }),
  });
  check(
    createRes.status === 201,
    `POST /projects returns 201 with a show-once token (got ${String(createRes.status)})`,
  );
  const createBody = (await createRes.json().catch(() => undefined)) as
    | { project?: { id?: unknown; tenant_id?: unknown }; api_key?: { token?: unknown } }
    | undefined;
  const createdToken = createBody?.api_key?.token;
  const createdProjectId = typeof createBody?.project?.id === 'string' ? createBody.project.id : '';
  const createdTenantId =
    typeof createBody?.project?.tenant_id === 'string' ? createBody.project.tenant_id : '';
  check(
    typeof createdToken === 'string' && createdToken.length > 0,
    'POST /projects response carries a non-empty show-once api_key token',
  );

  // Round-trip cache chỉ chạy khi token show-once có thật; trước đó fail-loud.
  if (typeof createdToken !== 'string' || createdToken.length === 0) {
    console.error(
      `SMOKE FAILED: ${failures.length} assertion(s) failed before the cache round trip.`,
    );
    process.exitCode = 1;
    return;
  }

  const cacheAuth = { authorization: `Bearer ${createdToken}` };
  const cachePayload = new TextEncoder().encode(
    `ecoma remote-cache control-plane smoke ${projectName}`,
  );
  // Hash nhận dạng — chuỗi safe theo regex route (`^[A-Za-z0-9._-]+$`); SHA-256
  // hex của tên project là giá trị ổn định, thỏa ràng buộc hình dạng.
  const cacheHash = await sha256Hex(projectName);

  const putRes = await fetch(`${baseUrl}/v1/cache/${cacheHash}`, {
    method: 'PUT',
    headers: {
      ...cacheAuth,
      'content-type': 'application/octet-stream',
      'content-length': String(cachePayload.byteLength),
    },
    body: cachePayload,
  });
  check(
    putRes.status === 201,
    `PUT /v1/cache on a fresh hash returns 201 (got ${String(putRes.status)})`,
  );

  const cacheGetRes = await fetch(`${baseUrl}/v1/cache/${cacheHash}`, { headers: cacheAuth });
  check(
    cacheGetRes.status === 200,
    `GET /v1/cache after PUT returns 200 (got ${String(cacheGetRes.status)})`,
  );
  if (cacheGetRes.status === 200 && cacheGetRes.body !== null) {
    const cacheGotBytes = await drainBody(cacheGetRes.body);
    check(
      Buffer.from(cacheGotBytes).equals(Buffer.from(cachePayload)),
      `GET /v1/cache body is byte-equal to the PUT payload (${cacheGotBytes.byteLength} vs ${cachePayload.byteLength} bytes)`,
    );
  }

  const dupRes = await fetch(`${baseUrl}/v1/cache/${cacheHash}`, {
    method: 'PUT',
    headers: {
      ...cacheAuth,
      'content-type': 'application/octet-stream',
      'content-length': String(cachePayload.byteLength),
    },
    body: cachePayload,
  });
  check(
    dupRes.status === 409,
    `re-PUT of the same hash returns 409 (got ${String(dupRes.status)})`,
  );

  // 4. Cleanup KHÔNG qua port của app: DELETE SigV4 của chính smoke cho object
  // storage smoke VÀ object cache E2E, rồi xác nhận mất.
  const deleteStatus = await signDeleteAndDispatch(
    { endpoint, bucket, accessKeyId, secretAccessKey: objectStorageSecret, region: 'auto' },
    key,
  );
  check(
    deleteStatus >= 200 && deleteStatus < 300,
    `raw signed S3 DELETE returns 2xx (got ${String(deleteStatus)})`,
  );
  const afterDelete = await storage.get(key);
  check(afterDelete === null, 'get after DELETE returns null (object removed)');

  if (createdTenantId !== '' && createdProjectId !== '') {
    const cacheObjectKey = `${createdTenantId}/${createdProjectId}/${cacheHash}`;
    const cacheDeleteStatus = await signDeleteAndDispatch(
      { endpoint, bucket, accessKeyId, secretAccessKey: objectStorageSecret, region: 'auto' },
      cacheObjectKey,
    );
    check(
      cacheDeleteStatus >= 200 && cacheDeleteStatus < 300,
      `raw signed S3 DELETE removes the smoke cache object (got ${String(cacheDeleteStatus)})`,
    );
  }

  if (failures.length > 0) {
    console.error(`SMOKE FAILED: ${failures.length} assertion(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('SMOKE PASSED: every real-storage and control-plane assertion held');
}

void main();
