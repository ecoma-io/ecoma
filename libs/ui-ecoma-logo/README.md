# UI Ecoma Logo

Thư viện brand logo của ecoma.io (`@ecoma-io/ui-ecoma-logo`): artwork SVG primary horizontal sống trong repo, render qua một Vue component dùng chung, cộng một URL asset đã resolve cho consumer cần phần tử ảnh tự quản. Consumer hiện tại: `apps/home`, `apps/backoffice`, `apps/llm-console`, `apps/llm-seller`, `apps/pact-broker-app`, `apps/remote-cache-app`.

Nx project `@ecoma-io/ui-ecoma-logo`, tags `type:application`, `scope:shared`, `runtime:universal`.

## Purpose

- Một nguồn artwork duy nhất thay vì mỗi app giữ bản copy SVG riêng: file nguồn `src/assets/ecoma-logo-horizontal.svg` là bất biến, mọi thay đổi artwork là thay đổi file nguồn chứ không phải code component.
- Cho logo đi theo design token của từng app thay vì nướng màu vào file: component render inline `<svg>` nên `fill` nhận được biến CSS của trang — điều `<img>` không làm được.

## Responsibilities

- **`EcomaLogo`** (`src/lib/components/EcomaLogo.vue`): render inline `<svg>` từ đúng hai path trong `src/lib/logo-artwork.ts` (xét cùng file nguồn bởi `ecoma-logo.spec.ts`). API tối giản: `alt` (mặc định `"ecoma.io"`) là prop duy nhất; mọi attribute khác fallthrough xuống `<svg>`, **trừ** `src`/`srcset`/`imagesrcset` và `width`/`height` — sizing chỉ đi qua CSS vì override một mình một phía làm méo artwork. Component không bọc link, không đọc router, không thêm margin.
- **`ECOMA_LOGO_HORIZONTAL_SVG_URL`** (`src/lib/logo-asset.ts`): URL của SVG nguồn đã được bundler resolve (dev server path hoặc hashed URL ở build); dùng khi consumer cần `<img>`, favicon hoặc ảnh tự quản.
- **Token yêu cầu**: mark dùng `fill-brand` (`--color-brand`), wordmark dùng `fill-foam` (`--color-foam`) — hai class này do Tailwind của consumer sinh ra từ CSS của app; mỗi app consumer đăng ký `@source` tới `libs/ui-ecoma-logo/src` và giữ test ghim (ví dụ `apps/home/app/assets/css/styles.spec.ts`, `apps/remote-cache-app/tests/tailwind-source.spec.ts`). Thiếu đăng ký thì logo render với `fill` mặc định.

## Boundaries

- Chỉ có **primary horizontal logo**: không có biến thể stacked, symbol, wordmark riêng hay colorway — biến thể mới cần thiết kế chính thức trước khi thêm.
- Không chỉnh sửa artwork bằng code: không recolor, không crop, không tween.
- Không phụ thuộc Nx project nào khác trong workspace và không có runtime dependency; chỉ cần `vue` và plugin bundler của app.
- Không biết Nx project, Worker name hay deploy unit.
- `runtime:universal`: render thuần server-compatible — không lifecycle hook, không `window`, không fetch.

## Development

```bash
pnpm nx run @ecoma-io/ui-ecoma-logo:lint
pnpm nx run @ecoma-io/ui-ecoma-logo:typecheck   # tsc --build tsconfig.json --emitDeclarationOnly
pnpm nx run @ecoma-io/ui-ecoma-logo:build       # tsc --build tsconfig.lib.json
```

Thay artwork là thay file SVG và cặp path tương ứng trong `logo-artwork.ts`; không sửa markup component để đổi hình.

## Testing

```bash
pnpm nx run @ecoma-io/ui-ecoma-logo:test    # vitest, environment node; component spec tự khai jsdom
```

Spec colocated: `ecoma-logo.spec.ts` (hình học path khớp file nguồn, filter attribute), `ecoma-logo-ssr.spec.ts` (render server), `ecoma-logo-reactivity.spec.ts` (đổi prop), `public-api.spec.ts` (bề mặt export).

## Related Documentation

- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — quy tắc Nx tags và `scope:shared` (§6).
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — build context của `apps/home` cần `libs/ui-ecoma-logo` (§Dockerfile và docker context).
- [`libs/ui-app-shell/README.md`](../ui-app-shell/README.md) — shell dashboard dùng component này trong slot `brand`.
- [`apps/home/`](../../apps/home/) — consumer dùng cả component và URL asset trên trang công khai.
