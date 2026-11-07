# ui-ecoma-logo

Thư viện **brand logo** của ecoma.io: artwork SVG nguồn sống trong repo và được phân phối qua một Vue component dùng chung, thay vì để mỗi app giữ bản copy SVG riêng.

## Library làm gì

- Lưu **primary horizontal logo** (SVG nguồn, giữ nguyên byte — artwork, hình học, tỷ lệ và màu sắc là bất biến) tại `src/assets/ecoma-logo-horizontal.svg`.
- Render logo qua component [`EcomaLogo`](#ecomalogo).
- Export [`ECOMA_LOGO_HORIZONTAL_SVG_URL`](#ecoma_logo_horizontal_svg_url) cho consumer cần phần tử ảnh tự quản (favicon, Open Graph image…).

## Library không làm gì

- Không tạo biến thể chưa có thiết kế chính thức: hiện **chỉ có primary horizontal logo**; stacked, symbol, wordmark riêng, colorway … chưa có ở đây và không được tự vẽ.
- Không chỉnh sửa SVG bằng code — không recolor, không crop, không tween; thay đổi artwork là thay đổi file nguồn, không phải component.
- Không bọc logo trong link, không đọc router, không áp margin/spacing — brand link và layout là việc của consumer.
- Không phụ thuộc library nào khác trong workspace (không cần locale, không cần layout) — chỉ `vue` và plugin bundler đã có sẵn.
- Không biết Nx project, Worker name hay deployment unit.

## `EcomaLogo`

```vue
<script setup lang="ts">
import { EcomaLogo } from '@ecoma-io/ui-ecoma-logo';
</script>

<template>
  <EcomaLogo class="h-6 w-auto" />
  <EcomaLogo alt="Về trang chủ ecoma.io" />
</template>
```

- `alt` (mặc định `"ecoma.io"`) là prop duy nhất — đủ cho accessibility (`aria-label` trên `<svg>`); ngữ nghĩa "logo của brand" là đủ, phần mô tả thêm thuộc ngữ cảnh dùng.
- Kích thước và style tùy chỉnh đi qua **CSS** (`class`/`style` fallthrough). `width`/`height` bị filter khỏi fallthrough: override một mình một trong hai làm méo artwork.
- Render thuần server-compatible: không lifecycle hook, không `window`, không fetch — tương thích SSR/SSG.
- Artwork render inline `<svg>` nên `fill` nhận được design token của consumer; không leak class generic (`.a`/`.b`) ra trang.

## Token yêu cầu: `fill-brand` và `fill-foam`

Logo render inline `<svg>` nên hai `<path>` phải tô bằng design token của consumer:

- mark → `fill-brand` (`--color-brand`, primary `#006AFF`)
- wordmark → `fill-foam` (`--color-foam`, màu chữ chính của body)

Vì `fill` attribute không có trên `<path>`, hai class này phải được Tailwind sinh ra từ CSS của consumer. consumer phải đăng ký nguồn library (xem dưới) — nếu không, logo sẽ render với `fill` mặc định (đen) và mất màu thương hiệu.

## `ECOMA_LOGO_HORIZONTAL_SVG_URL`

```ts
import { ECOMA_LOGO_HORIZONTAL_SVG_URL } from '@ecoma-io/ui-ecoma-logo';
```

URL của SVG nguồn, đã được bundler resolve (dev server path hoặc hashed URL ở build). Dùng khi consumer cần phần tử ảnh tự quản thay vì component; không hard-code URL này ở bất kỳ đâu. **Lưu ý**: URL là đường dẫn tương đối với origin và đổi theo mỗi build (hash) — use case cần URL tuyệt đối ổn định (Open Graph image, schema.org logo…) phải do consumer tự prefix origin hoặc copy asset, không dựng `<meta>` trực tiếp từ URL này.

## Bắt buộc: đăng ký Tailwind source

Library này dùng Tailwind utility classes (`fill-brand`, `fill-foam`) trong component. Tailwind v4 chỉ sinh utility từ các file mà nó quét — và library nằm ngoài module graph của app, nên **app consumer phải đăng ký nguồn library trong `style.css` của chính app**. Nếu bỏ qua, CSS production không chứa `fill-brand`/`fill-foam` và logo mất màu.

Ví dụ cho `apps/home` (`apps/home/app/assets/css/styles.css`):

```css
@source "../../../../../libs/ui-ecoma-logo/src/**/*.{vue,ts}";
```

Đường dẫn tính **tương đối với chính file stylesheet** này tới thư mục nguồn của library — từ `apps/home/app/assets/css/` phải là **5** cấp `..` mới về workspace root; đếm thiếu một cấp sẽ trỏ vào thư mục không tồn tại và Tailwind **bỏ qua âm thầm** (không lỗi build, chỉ mất utility).

Cách verify **sai** (đã từng cho kết quả xanh giả): grep `.fill-brand` trong `.output/public/_nuxt/*.css`. App thường đã chứa chuỗi đó ở chỗ khác (spec, comment) nên Tailwind tự quét `apps/home/**` và vẫn sinh utility dù `@source` trỏ sai.

Cách verify **đúng**: thêm tạm một class chỉ tồn tại trong library vào `EcomaLogo.vue`, build production, rồi kiểm class đó có trong `.output/public/_nuxt/*.css`. `apps/home/tests/tailwind-source.spec.ts` ghim bất biến này tự động cho `apps/home` (resolve base của mọi `@source` từ thư mục chứa stylesheet + `existsSync` + khẳng định phủ đúng `libs/ui-ecoma-logo/src` với glob có `.vue`). Hai consumer còn lại (`apps/backoffice`, `apps/pact-broker-app`) cũng đăng ký `@source` cho thư mục này nhưng test ghim của chúng (`apps/backoffice/app/assets/css/styles.spec.ts`, `apps/pact-broker-app/tests/tailwind-source.spec.ts`) hiện chỉ ghim riêng `libs/ui-app-shell/src` — chưa có app nào khác ghim riêng thư mục của logo.

Không dùng broad workspace scan thay vì đăng ký tương đối — nó không giải quyết được vấn đề cho consumer mới.

## Phân biệt component và URL asset

- **Component** (`EcomaLogo`): render inline SVG, styleable qua CSS, dùng cho hiển thị trong trang.
- **URL asset** (`ECOMA_LOGO_HORIZONTAL_SVG_URL`): đường dẫn file SVG, dùng khi consumer cần phần tử ảnh tự quản (favicon, `<img>`, Open Graph).

## Giới hạn hiện tại

- Chỉ có **primary horizontal logo** từ SVG nguồn. Các biến thể khác (stacked, symbol, wordmark riêng, colorway) cần thiết kế chính thức trước khi thêm vào library.
