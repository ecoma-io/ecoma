/**
 * Port `CacheObjectStorage` va hai implementation: in-memory (test seam) va
 * S3-compatible (production, Web Crypto + fetch, AWS Sig V4).
 *
 * Port nay la ranh gioi giua data plane va object storage: route chi noi chuyen
 * qua port, khong biet backend cu the. Implementation S3 dung
 * `x-amz-content-sha256: UNSIGNED-PAYLOAD` cho PUT de stream body ma khong phai
 * buffer toan bo de tinh hash (invariant streaming cua remote-cache).
 */

/** Ket qua cua mot lan `putIfAbsent`. */
export type PutResult = 'created' | 'exists';

/** Port toi object storage — backend-agnostic. */
export interface CacheObjectStorage {
  /** Tra ve body + size neu object ton tai, null neu miss. */
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  /** Conditional creation: thanh cong 'created', da ton tai 'exists'. */
  putIfAbsent(
    key: string,
    body: ReadableStream<Uint8Array>,
    size: number,
    contentType: string | null,
  ): Promise<PutResult>;
}

/** Implementation in-memory — dung lam test seam (env.CACHE_STORAGE) va local dev. */
export class InMemoryObjectStorage implements CacheObjectStorage {
  private readonly objects = new Map<string, { data: Uint8Array; contentType: string | null }>();

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
    const obj = this.objects.get(key);
    if (obj === undefined) {
      return null;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(obj.data);
        controller.close();
      },
    });
    return { body: stream, size: obj.data.byteLength };
  }

  async putIfAbsent(
    key: string,
    body: ReadableStream<Uint8Array>,
    size: number,
    contentType: string | null,
  ): Promise<PutResult> {
    // Drain body trước để không leak; sau khi drain, kiểm tra lại race: hai
    // request đồng thời có thể cùng vượt qua `has(key)` ban đầu và ghi thừa.
    // Kiểm tra sau khi đã drain (không thể check trước vì body phải drain).
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(value);
    }
    if (this.objects.has(key)) {
      return 'exists';
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.byteLength;
    }
    // Không tin size caller khi không khop — dùng số byte thực tế.
    void size;
    this.objects.set(key, { data, contentType });
    return 'created';
  }
}

/** Cau hinh S3-compatible backend. */
export interface S3StorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

/** Implementation S3-compatible (B2/R2) qua fetch + AWS Sig V4. */
export class S3ObjectStorage implements CacheObjectStorage {
  constructor(private readonly config: S3StorageConfig) {}

  private objectUrl(key: string): string {
    const base = this.config.endpoint.replace(/\/+$/u, '');
    return `${base}/${this.config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async sign(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payloadHash: string,
  ): Promise<Record<string, string>> {
    const accessKey = this.config.accessKeyId;
    const secretKey = this.config.secretAccessKey;
    const region = this.config.region;
    const service = 's3';
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]/gu, '')
      .replace(/\.\d{3}Z$/u, 'Z');
    const dateStamp = amzDate.slice(0, 8);

    const host = url.host;
    const canonicalUri = url.pathname;
    const canonicalQuerystring = url.searchParams.toString();

    // Header bắt buộc phải ký: host, x-amz-date, x-amz-content-sha256.
    // Nếu thêm sau khi tính SignedHeaders, chúng không nằm trong chữ ký và
    // S3/B2/R2 có thể từ chối (host tối thiểu phải được ký).
    const signedHeaderSet: Record<string, string> = {
      ...headers,
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    // ⚠️ canonicalHeaders phải lookup theo key lowercase — signedHeaderSet giữ
    // nguyên casing caller truyền (ví dụ 'Content-Type'), signedHeadersList đã
    // lowercase. Lookup `signedHeaderSet[h]` với h lowercase trả '' → signature
    // sai, S3/B2/R2 từ chối. Build lowercased map để lookup đúng.
    const signedHeaderLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(signedHeaderSet)) {
      signedHeaderLower[k.toLowerCase()] = v;
    }
    const signedHeadersList = Object.keys(signedHeaderLower).toSorted();
    const signedHeaders = signedHeadersList.join(';');

    const canonicalHeaders = signedHeadersList
      .map((h) => `${h}:${(signedHeaderLower[h] ?? '').trim()}\n`)
      .join('');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = await hmacSha256(`AWS4${secretKey}`, dateStamp);
    const kRegion = await hmacSha256Bytes(kDate, region);
    const kService = await hmacSha256Bytes(kRegion, service);
    const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
    const signature = await hmacSha256HexBytes(kSigning, stringToSign);

    const awsAuthorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...signedHeaderSet,
      authorization: awsAuthorization,
    };
  }

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
    const url = new URL(this.objectUrl(key));
    const headers: Record<string, string> = {};
    const signed = await this.sign('GET', url, headers, EMPTY_SHA256);
    const res = await fetch(url.toString(), { method: 'GET', headers: signed });
    if (res.status === 404) return null;
    if (!res.ok || res.body === null) {
      throw new Error(`S3 GET failed: ${res.status}`);
    }
    const size = Number(res.headers.get('content-length') ?? '0');
    return { body: res.body as ReadableStream<Uint8Array>, size };
  }

  async putIfAbsent(
    key: string,
    body: ReadableStream<Uint8Array>,
    size: number,
    contentType: string | null,
  ): Promise<PutResult> {
    const url = new URL(this.objectUrl(key));
    const headers: Record<string, string> = {
      'content-length': String(size),
    };
    if (contentType !== null) {
      headers['content-type'] = contentType;
    }
    // Conditional creation: object must not already exist.
    headers['if-none-match'] = '*';
    const signed = await this.sign('PUT', url, headers, 'UNSIGNED-PAYLOAD');
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: signed,
      body: body as unknown as BodyInit,
      // @ts-expect-error duplex is required by some runtimes for streaming body
      duplex: 'half',
    });
    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return 'created';
    }
    // ⚠️ Chỉ 412 (Precondition Failed) và 409 (Conflict) → 'exists'. 403
    // (Forbidden) và 400 (Bad Request) là lỗi config/quyền/storage — mapping
    // chúng thành 'exists' che giấu lỗi và có thể trả 409 sai cho client.
    if (res.status === 412 || res.status === 409) {
      return 'exists';
    }
    throw new Error(`S3 PUT failed: ${res.status}`);
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
