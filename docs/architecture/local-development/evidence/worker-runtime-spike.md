# Worker Local Runtime Spike (PR1)

## 1. Mục tiêu

Xác minh Wrangler 4.151.1 (pin trong `package.json`) và cấu hình Cloudflare hiện tại của
`transactional-mail` + `transactional-mailer-job` có thể chạy như một đồ thị local với D1,
Queue producer/consumer, Service Binding và Cron triggerable. Không xây process manager
generic ở PR này.

## 2. Bằng chứng đã đo

- `node node_modules/wrangler/bin/wrangler.js --version` → `4.151.1`.
- `wrangler dev --config apps/transactional-mail/wrangler.jsonc --persist-to <dir> --port 8899`
  boot thành công, bindings:
  - `env.QUEUE` (ecoma-mail-delivery) — Queue local
  - `env.mail` (mail) — D1 local
  - Scheduled Workers warning: cron không tự chạy; trigger thủ công qua
    `POST http://localhost:8899/cdn-cgi/local/scheduled` hoặc Explorer API.
- `wrangler dev --config apps/transactional-mailer-job/wrangler.jsonc ... --port 8898`
  boot thành công, bindings:
  - `env.mail-job` (mail-job) — D1 local
  - `env.TRANSACTIONAL_MAIL_SERVICE` (ecoma-transactional-mail) — Worker local `[connected]`
    khi control plane chạy cùng persist dir.
- Migration:
  - `wrangler d1 migrations apply mail --local --persist-to <dir>` → 7 migration áp dụng.
  - `wrangler d1 migrations apply mail-job --local --persist-to <dir>` → 2 migration áp dụng.
- `--persist-to <dir>`: state nằm tại `<dir>/v3/{d1,queues,...}`. Hai process dùng chung
  persist dir chia D1 state; `getPlatformProxy` trỏ vào `<dir>/v3`.
- Service Binding local kết nối theo tên Worker và trạng thái `[connected]`/`[not connected]`
  được cập nhật khi process peer xuất hiện.
- Cron triggerable thủ công qua endpoint Explorer; không tự chạy theo interval trong dev.
- Health endpoint `GET /health` của control plane trả 200 mà không chạm D1/Queue.

## 3. Hành vi không hỗ trợ / giới hạn

- Queue transport thật của Cloudflare không có trong local dev; producer ghi vào queue local
  trong persist dir, consumer phải được trigger qua queue polling của wrangler dev. Trong test
  harness queue được mô phỏng bằng mảng envelope (xem `main.spec.ts`).
- Cron không tự chạy theo interval; phải trigger thủ công hoặc qua Explorer API.
- `database_id` không được khai báo trong committed wrangler config; local dev dùng tên
  database (`mail`, `mail-job`) và persist dir, không cần provision D1 thật.
- Service Binding chỉ kết nối khi process peer cùng persist/network và đang chạy.

## 4. Topology đã chọn

- Control plane và job chạy như hai process `wrangler dev` riêng, chia sẻ `--persist-to`
  để D1 state khớp.
- Không publish thêm host port cho workerd ngoài Traefik? Worker dev bind localhost
  (127.0.0.1) cho dev convenience; platform Traefik vẫn là host-port publisher duy nhất
  cho home app. Nếu cần tuân thủ nghiêm ngặt "chỉ Traefik publish host port", chạy
  wrangler dev bên trong container gắn mạng ecoma và không map port host — Traefik route
  tới port nội bộ. Điều này hoãn sang PR4 và cần process manager.
- Migrations/seeds chỉ target local persist dir; fail closed nếu `--remote` được thêm.

## 5. Kết luận

Capability cốt lõi (D1 local, Queue local, Service Binding local, Cron trigger thủ công,
migration local, persistence chia sẻ) đều hoạt động trên Wrangler 4.151.1. PR2–PR6 có thể
tiến hành trên topology hai process + shared persist dir.
