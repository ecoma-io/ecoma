#!/usr/bin/env bash
#
# Đảm bảo Playwright chromium sẵn sàng trước khi suite browser chạy bên trong
# target `test-integration` (06-testing.md — suite app-owned gắn vào
# test-integration, không phải target `e2e` riêng).
#
# Vì sao script này nằm trong suite mà không phải trong CI workflow: file
# workflow thuộc hạ tầng repo, không thuộc project `apps/pact-broker-app`; để
# target tự cấp phụ thuộc trình duyệt thì project chạy được ở **mọi** nơi target
# chạy (CI runner mới, worktree khác, máy dev mới) mà không ai phải nhớ cài gì.
#
# Hai bước, mỗi bước một lý do riêng:
#
# 1. Binary chromium: `playwright install` theo **phiên bản** — cache theo
#    phiên bản đã có thì là no-op (nhanh), chưa có thì tải đúng bản khớp package
#    (`playwright` CLI resolve từ devDependency `@playwright/test` của ROOT
#    workspace, nên không bao giờ hardcode số phiên bản ở đây).
# 2. Thư viện hệ điều hành: chỉ làm trên CI (`CI=true`) — runner hosted cần
#    `apt-get` qua sudo để đủ libs chromium, còn máy dev đã có sẵn (và tự ý chạy
#    `sudo apt-get` trên máy cá nhân là hành vi sai).
#
# Fail-loud: bước nào lỗi thì target đỏ tại bước đó, không nuốt lỗi để suite
# chạy với binary thiếu rồi đỏ ở chỗ mơ hồ hơn.
#
# Khác `apps/backoffice` ở **thứ tự**, không phải cơ chế: suite browser của app
# này chạy BÊN TRONG vitest (`tests/browser/read-pages.spec.ts` tự
# `chromium.launch()`), không phải lane `playwright test` riêng, nên bước cấp
# binary phải đứng TRƯỚC lệnh vitest của target.

set -euo pipefail

cd "$(dirname "$0")/../.."

# ⚠️ Chống treo vô hạn: `set -euo pipefail` chỉ bắt exit code khác 0, không xử
# lý tiến trình treo (mạng đứt, DNS chậm, registry không phản hồi) — không có
# watchdog thì target `test-integration` treo luôn và khoá CI worker.
#
# Bước 1 chạy trên **mọi** máy target chạy, kể cả máy dev macOS nơi GNU coreutils
# (`timeout`) không có sẵn — watchdog của bước 1 dựng trên `node child_process`,
# dependency chắc chắn có của repo, hoạt động giống nhau trên Linux/macOS.
# Exit 124 khi hết giờ, cùng quy ước với GNU `timeout`.
#
# Bước 2 chỉ chạy trên CI (`CI=true`) — Linux runner luôn có GNU `timeout`, nên
# giữ nguyên. Nới hạn: tải chromium (~170MB) trong 300s; `install-deps` chạy
# `apt-get` trên CI runner nên cho 600s.
run_with_timeout() {
  local seconds="$1"
  shift
  node -e '
    const { spawn } = require("node:child_process");
    const [ms, ...argv] = process.argv.slice(1);
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), Number(ms));
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      process.exit(signal !== null ? 124 : (code ?? 1));
    });
  ' "$((seconds * 1000))" "$@"
}

run_with_timeout 300 npx playwright install chromium

if [ "${CI:-}" = "true" ]; then
  timeout 600 npx playwright install-deps chromium
fi
