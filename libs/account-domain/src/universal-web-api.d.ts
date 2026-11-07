/**
 * Khai báo global tối thiểu cho các Web API mà `@ecoma-io/account-domain` thực dùng:
 * WebCrypto (`crypto.subtle` HMAC + PBKDF2, `crypto.getRandomValues`), `TextEncoder`,
 * `URLSearchParams` và `BufferSource`.
 *
 * ⚠️ **Vì sao không thêm `"dom"` vào `lib` hay dùng `@cloudflare/workers-types`:** lib
 * mang tag `runtime:universal` — cam kết chạy được trên cả Cloudflare Workers lẫn Node
 * (vitest chạy trên Node). Typecheck dưới global Workers/dom sẽ cho qua API chỉ một
 * bên có (`caches.default`, `document`, …) và code như vậy compile xanh nhưng chết
 * lúc chạy Node. Cùng lý do, `internal-auth-contracts` giữ `src/universal-web-api.d.ts`
 * riêng của nó. Mọi API khai dưới đây thuộc phần giao thực có trên cả Workers lẫn
 * Node ≥ 19, nên khai báo đúng phần dùng là ràng buộc chặt nhất: thêm API Workers-only
 * hay browser-only vào lib này sẽ FAIL typecheck ngay.
 *
 * Giữ file này cùng version với usage trong `totp.ts` / `recovery-codes.ts` — thêm
 * call site mới dùng Web API thì mở rộng interface ở đây, không thêm workers-types
 * hay lib `dom` trở lại.
 */

/** WebCrypto — chỉ khai báo đúng phần mà lib này gọi, theo mặt phẳng WHATWG thật. */
interface UniversalSubtleCrypto {
  importKey(
    format: string,
    keyData: Uint8Array,
    algorithm: string | { readonly name: string; readonly hash: string },
    extractable: boolean,
    usages: readonly string[],
  ): Promise<object>;
  sign(
    algorithm: string | { readonly name: string },
    key: object,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  deriveBits(
    algorithm: {
      readonly name: string;
      readonly salt: BufferSource;
      readonly iterations: number;
      readonly hash: string;
    },
    key: object,
    length: number,
  ): Promise<ArrayBuffer>;
}

declare const crypto: {
  readonly subtle: UniversalSubtleCrypto;
  /** CSPRNG — có trên Workers và Node ≥ 19; trả buffer đầu vào đã điền byte ngẫu nhiên. */
  getRandomValues<T extends Uint8Array>(array: T): T;
};

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** Biến thể URL không gắn `location` — đủ cho dựng `otpauth://` URI (WHATWG URL spec). */
declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  toString(): string;
}

/**
 * `ArrayBufferView | ArrayBuffer` — khái niệm Web platform (WebIDL), KHÔNG phải DOM;
 * `crypto.subtle.deriveBits` của spec nhận salt kiểu này. Khai tại đây vì lib `es2022`
 * của base tsconfig không mang nó, và lib này không bật lib `dom`.
 */
type BufferSource = ArrayBufferView | ArrayBuffer;
