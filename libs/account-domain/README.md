# Account Domain

Thư viện domain của bounded context `account` (`@ecoma-io/account-domain`): value object, invariant vòng đời và policy thuần. Thư viện **không import Nx project khác, không SQL, không Node builtin, không I/O** — tham số thời gian do caller truyền vào, entropy thì caller truyền hoặc để mặc định lấy từ Web Crypto (`src/index.ts`); `package.json` không có runtime dependency nào.

Ngữ nghĩa nghiệp vụ canonical của context nằm ở `docs/domains/account/` — thư viện này hiện thực một phần tri thức đó bằng code, không định nghĩa lại ranh giới context.

Nx project `@ecoma-io/account-domain`, tags `type:domain`, `scope:account`, `runtime:universal`.

## Purpose

- Tập trung invariant thuần của context `account` vào một thư viện tái sử dụng, không kéo theo persistence hay transport.
- Entry công khai duy nhất là `src/index.ts` (`main` của package).

## Responsibilities

Exports công khai (từ `src/index.ts`):

- **Subject identity**: `createSubject`, `isSubject`, `subjectEntropy` (`subject.ts`).
- **Vòng đời account**: `ACCOUNT_STATUSES`, kiểm tra terminal/tombstone (`account-status.ts`).
- **Assurance (ACR)**: `ACR_VALUES`, `acrSatisfies` và các guard shape (`acr.ts`).
- **Session policy**: hết hạn, revoked, yêu cầu re-authentication (`session-policy.ts`).
- **OTP/MFA primitives**: base32 codec (`base32.ts`), TOTP sinh/verify/otpauth URI với tham số step/drift tường minh (`totp.ts`), recovery codes sinh/format/hash/verify (`recovery-codes.ts`).
- **Domain errors**: `DomainError`, `DomainErrorCode`, catalog message (`errors.ts`).

Consumer hiện tại: `apps/account` — dùng `ACR`, `isSubject`, `isAccountStatus` (`server/lib/session.ts`, `server/routes/internal/account/`).

## Boundaries

- Không chứa persistence, adapter HTTP/transport hay binding — các lớp đó thuộc app tiêu thụ (`apps/account`).
- Không định nghĩa contract vượt biên deploy unit: surface contract nằm ở các contract library riêng (`libs/account-contracts`, `libs/internal-auth-contracts`).
- Rule Nx theo scope và loại project → `docs/architecture/05-code-architecture.md` §6.3.

## Development

```bash
pnpm nx run @ecoma-io/account-domain:lint
pnpm nx run @ecoma-io/account-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới đồng nghĩa với thêm file và spec colocated cạnh nó, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/account-domain:test        # vitest — spec colocated trong src/
```

Spec colocated cạnh subject, ví dụ `totp.spec.ts` cạnh `totp.ts`.

## Related Documentation

- [`docs/domains/account/README.md`](../../docs/domains/account/README.md) — bounded context `account`.
- [`docs/domains/account/domain-model.md`](../../docs/domains/account/domain-model.md) — khái niệm, mô hình assurance, vòng đời, invariant nghiệp vụ.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — rule Nx theo scope (§6.3).
- [`apps/account/README.md`](../../apps/account/README.md) — consumer hiện tại của thư viện.
