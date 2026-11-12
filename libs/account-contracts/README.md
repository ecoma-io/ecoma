# Account Contracts

Contract surface mà provider `account` **publish** cho consumer của nó: shape wire của `GET /internal/account/status` và `GET /internal/account/profiles`, cùng validator hình thức tương ứng. Nhà cung cấp của contract là `account`; consumer thật là `auth` (status) và `backoffice` (profiles).

Lib này **không** import Nx project khác ngoài `@ecoma-io/internal-auth-contracts`, **không** có domain logic và **không** import `@ecoma-io/account-domain` — constraint `type:contracts` trong `.oxlintrc.json` cấm phụ thuộc `type:domain` (kể cả transitive), vì contract là thứ provider publish chứ không phải tầng để đi theo chiều phụ thuộc. Vì vậy mọi giá trị wire được khai báo lại bằng union `wire` tại đây.

Nx project `@ecoma-io/account-contracts`, tags `type:contracts`, `scope:account`, `runtime:universal`.

## Purpose

- Là bản publish duy nhất của các contract internal do `account` phục vụ, để consumer phụ thuộc vào contract thay vì vào implementation của provider.
- Chốt ranh giới dữ liệu của từng contract bằng type + validator, không bằng quy ước miệng.

## Responsibilities

- **`account-status-contract.ts`** — contract `GET /internal/account/status?sub=`: union `AccountStatusResponseValue` (`active` | `suspended` | `deleted` | `not_found`), thân response đúng một trường `status`, danh sách trường bị cấm `FORBIDDEN_ACCOUNT_STATUS_FIELDS`, và `validateAccountStatusResponse` trả kết quả discriminated union.
- **`account-profiles-contract.ts`** — contract `GET /internal/account/profiles?subs=<sub1,sub2,...>`: `ACCOUNT_PROFILES_MAX_SUBS = 100`, `ACCOUNT_PROFILES_DISPLAY_NAME_MAX_LENGTH = 200`, entry `AccountProfileEntry` (`sub` + `displayName`, `null` là giá trị hợp lệ), `dedupeProfileSubs`, `validateAccountProfilesResponse`.
- **`index.ts`** — barrel export; re-export giao thức envelope HMAC từ `@ecoma-io/internal-auth-contracts` để caller và callee của contract `account` ký/kiểm qua một nguồn duy nhất.

Consumer hiện tại: `apps/auth` (`src/account-client.ts`, `src/oidc/issuance-gate.ts`, `src/session-verified-handler.ts`), `apps/account` (hai route `server/routes/internal/account/`), `libs/auth-domain` (`issuance-policy.ts` nhận union trạng thái của contract), `libs/backoffice-infrastructure` (`src/account/client.ts`).

## Boundaries

- Không chứa nghiệp vụ, không persistence, không transport — contract chỉ mô tả shape message và validator hình thức.
- Không định nghĩa lại ranh giới của context `account`; ngữ nghĩa nghiệp vụ canonical nằm ở `docs/domains/account/`.
- Không khai lại envelope HMAC: bản cài đặt canonical của giao thức thuộc `@ecoma-io/internal-auth-contracts` (`scope:platform`), không mang khái niệm định danh (không principal, không user).

## Development

```bash
pnpm nx run @ecoma-io/account-contracts:lint
pnpm nx run @ecoma-io/account-contracts:typecheck
```

Mã nguồn nằm dưới `src/`; entry công khai duy nhất là `src/index.ts` (`main` của package). Thêm contract mới = thêm file trong `src/` và export qua barrel.

## Testing

```bash
pnpm nx run @ecoma-io/account-contracts:test        # vitest — spec colocated trong src/
```

Spec colocated cạnh module, ví dụ `account-status-contract.spec.ts` cạnh `account-status-contract.ts`.

## Related Documentation

- [`docs/applications/account/01-architecture.md`](../../docs/applications/account/01-architecture.md) — §5.1 hai loại contract, §5.2 contract `profiles`, §5.3 contract `status`.
- [`docs/domains/account/README.md`](../../docs/domains/account/README.md) — bounded context `account`.
- [`libs/internal-auth-contracts/README.md`](../internal-auth-contracts/README.md) — envelope HMAC dùng chung.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §4 contracts (provider-owned, độc lập với implementation).
- [`apps/account/README.md`](../../apps/account/README.md) — provider phục vụ hai contract này.
