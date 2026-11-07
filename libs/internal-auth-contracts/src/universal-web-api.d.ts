/**
 * Khai báo global tối thiểu cho hai API WHATWG mà `@ecoma-io/internal-auth-contracts`
 * thực dùng: WebCrypto (`crypto.subtle`, `crypto.randomUUID`) và `TextEncoder`.
 *
 * ⚠️ **Vì sao không dùng `@cloudflare/workers-types`:** lib mang tag
 * `runtime:universal` — cam kết chạy được trên cả Cloudflare Workers lẫn Node
 * (test/vitest chạy trên Node). Typecheck dưới global Workers sẽ cho qua API
 * Workers-only (Durable Object, `caches.default`, `ExecutionContext`, …) và code
 * như vậy compile xanh nhưng chết lúc chạy Node. Hai API khai dưới đây là phần
 * giao thực có thật của cả hai runtime (WebCrypto có ở Workers và Node ≥ 19),
 * nên khai báo đúng phần dùng là ràng buộc chặt nhất: thêm API Workers-only hay
 * browser-only vào lib này sẽ FAIL typecheck ngay.
 *
 * Giữ file này cùng version với usage trong `internal-auth.ts` — thêm call site
 * mới dùng WebCrypto thì mở rộng interface ở đây, không thêm `workers-types`
 * trở lại.
 */

/** WebCrypto — chỉ khai báo đúng phần mà lib này gọi, theo mặt phẳng WHATWG thật. */
interface UniversalSubtleCrypto {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: Uint8Array,
    algorithm: { readonly name: string; readonly hash: string | { readonly name: string } },
    extractable: boolean,
    usages: readonly string[],
  ): Promise<object>;
  sign(algorithm: string, key: object, data: Uint8Array): Promise<ArrayBuffer>;
}

declare const crypto: {
  readonly subtle: UniversalSubtleCrypto;
  randomUUID(): string;
};

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
