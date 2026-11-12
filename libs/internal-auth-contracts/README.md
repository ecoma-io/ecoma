# Internal Auth Contracts

Giao thức envelope HMAC dùng chung cho mọi cặp service nội bộ ký/verify request-to-request: một bản cài đặt duy nhất tại `src/internal-auth.ts`, re-export cho caller lẫn callee của từng contract. Consumer trực tiếp hiện tại là `apps/account`, `apps/staff-access`, `apps/transactional-mail` và `apps/auth` (qua `@ecoma-io/auth-contracts`); hai contract lib `@ecoma-io/account-contracts` và `@ecoma-io/auth-contracts` re-export lại từ đây cho đúng phía của mình.

Giao thức **không** mang khái niệm của một bounded context nào (không principal, không user, không permission — receiver tự suy consumer từ credential), nên nơi canonical của nó là tầng nền `scope:platform`, không phải một scope nghiệp vụ. Định danh giao thức là hằng `PROTOCOL_ID` trong `src/internal-auth.ts`; giá trị hiện tại trong source là `ecoma-internal-v2`.

Nx project `@ecoma-io/internal-auth-contracts`, tags `type:contracts`, `scope:platform`, `runtime:universal`.

## Purpose

- Đặt envelope HMAC — chống replay bền (nonce + cửa sổ skew), fail-closed, canonical string đơn ánh — ở đúng một nơi để hai đầu của một contract không thể trôi lệch.
- Thay Service Binding bằng một authenticator ở tầng ứng dụng: Service Binding là cơ chế cô lập, không phải cơ chế xác thực, nên phía gọi ký bằng secret dùng chung và phía nhận kiểm chữ ký trước khi tin dữ liệu nào.

## Responsibilities

Surface công khai (từ `src/index.ts`, toàn bộ đến từ `internal-auth.ts`):

- **Canonical string**: `canonicalString` với dạng `<method>\n<proto>\n<len(path)>:<path>\n<len(timestamp)>:<timestamp>\n<len(nonce)>:<nonce>\n<bodyHash>`; mọi trường biến đổi có length prefix byte UTF-8, `method` được neo bởi `PROTOCOL_ID`; từ chối trường chứa lone surrogate thay vì canonical hoá im lặng.
- **Ký và kiểm**: `signRequest`, `verifyRequest` trả discriminated union `VerifyResult` với `VerifyFailureReason`; `hashBody` băm đúng byte thân request (`Uint8Array`); `timingSafeEqualHex`.
- **Nonce và skew**: `createNonce`, `isStrongNonce`, `DEFAULT_SKEW_SECONDS`/`MIN_SKEW_SECONDS`/`MAX_SKEW_SECONDS`/`resolveSkewSeconds`, `NONCE_TTL_BUFFER_SECONDS`, `isValidNonceExpirySeconds`/`assertNonceExpirySeconds`, `MAX_NONCE_CHARS`, `MAX_NONCE_EXPIRY_EPOCH_SECONDS`.
- **Header và giới hạn**: `INTERNAL_NONCE_HEADER`, `INTERNAL_SIGNATURE_HEADER`, `INTERNAL_TIMESTAMP_HEADER`, `INTERNAL_KID_HEADER`, `INTERNAL_ACTOR_SUB_HEADER`, `INTERNAL_BODY_LIMIT_BYTES`, `InvalidCanonicalFieldError`, `InvalidKidError`.

## Boundaries

- Không chứa logic của bất kỳ bounded context nào; một khái niệm nghiệp vụ lọt vào đây là vi phạm taxonomy `scope:platform`.
- Không có bản cài đặt thứ hai của giao thức: các contract lib nghiệp vụ chỉ re-export, không khai lại hằng hay header.
- `pnpm dx arch-check` chặn consumer `scope:messaging` phụ thuộc contracts của `scope:account`/`scope:auth`; đường đi hợp lệ duy nhất cho giao thức là package platform này.

## Development

```bash
pnpm nx run @ecoma-io/internal-auth-contracts:lint
pnpm nx run @ecoma-io/internal-auth-contracts:typecheck
```

Mã nguồn nằm dưới `src/`; entry công khai duy nhất là `src/index.ts` (`main` của package). Đổi bất kỳ hằng wire nào (`PROTOCOL_ID`, header name, skew) là phá vỡ giao thức trên dây — cả hai phía phải đổi cùng lúc.

## Testing

```bash
pnpm nx run @ecoma-io/internal-auth-contracts:test   # vitest — spec colocated trong src/
```

`internal-auth.spec.ts` phủ canonical string, verify fail-closed và các nhánh từ chối của giao thức.

## Related Documentation

- [`docs/applications/auth/01-architecture.md`](../../docs/applications/auth/01-architecture.md) — §5.1.8 envelope nội bộ (một giao thức canonical, chống replay bền).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §4 contracts (protocol nền tảng dùng chung nhiều BC có đúng một project owning, tag `scope:platform`).
- [`libs/account-contracts/README.md`](../account-contracts/README.md) và [`libs/auth-contracts/README.md`](../auth-contracts/README.md) — hai contract lib re-export giao thức này.
- [`libs/AGENTS.md`](../AGENTS.md) — sở hữu contract là quyết định của provider, kèm chi phí lệch hợp đồng im lặng.
