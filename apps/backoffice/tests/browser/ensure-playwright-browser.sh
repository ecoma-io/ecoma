#!/usr/bin/env bash
#
# Đảm bảo Playwright chromium sẵn sàng trước khi suite browser chạy bên trong
# target `test-integration` (06-testing.md — suite app-owned gắn vào
# test-integration, không phải target `e2e` riêng).
#
# Script này giữ vai trò **cấp phụ thuộc trình duyệt cho project**, để target
# chạy được ở mọi nơi target chạy (worktree khác, máy dev mới) mà không ai phải
# nhớ cài gì. Nhưng nó **không** phải nơi cấp browser trên CI: job
# `integration-test` đã chạy `npx playwright install --with-deps chromium` một
# lượt trước khi Nx khởi động (xem `.github/workflows/ci.yaml`), nên trên CI
# script này phải là một **cache hit**.
#
# ⚠️ Vì sao CI không được tự cài (issue #253): affected set rộng chạy
# `nx affected -t build,test-integration --parallel=6` trên runner 4 vCPU, nên
# script của `backoffice` và `pact-broker-app` chạy đồng thời với 5 task nặng
# khác. Mỗi bản gọi `playwright install` — tải song song vào cùng
# `~/.cache/ms-playwright` — và, khi `CI=true`, `install-deps` (`sudo apt-get`),
# tức hai lượt apt-get/dpkg chồng nhau trên cùng máy. Với affected set hẹp (như
# lần #247 kiểm) chỉ một bản chạy nên lỗi không lộ ra. Vì vậy trên CI script chỉ
# **kiểm cache**: có binary đúng phiên bản thì thoát ngay — không mạng, không
# sudo, không tranh chấp.
#
# Ngoài CI (máy dev) script vẫn tự cài binary: `playwright install` theo
# **phiên bản** — cache có rồi thì no-op, chưa có thì tải đúng bản khớp package.
# Máy dev không chạy `apt-get`: tự ý `sudo apt-get` trên máy cá nhân là hành vi
# sai, và máy dev đã có sẵn thư viện hệ điều hành.
#
# Fail-loud: thiếu binary trên CI là lỗi cấu hình job (thiếu bước cấp browser),
# báo thẳng thay vì tải trong lúc 5 task khác đang chạy. Bước nào lỗi thì target
# đỏ tại bước đó, không nuốt lỗi để suite chạy với binary thiếu rồi đỏ ở chỗ mơ
# hồ hơn.

set -euo pipefail

cd "$(dirname "$0")/../.."

# Kiểm cache theo **phiên bản package**, không hardcode số phiên bản:
# `chromium.executablePath()` resolve tới đúng bản mà `@playwright/test` của
# workspace mong đợi, và `existsSync` xác nhận nó có thật trong
# `~/.cache/ms-playwright`.
#
# Mã thoát phân biệt hai nguyên nhân: 0 = có binary, 1 = thiếu binary nhưng
# module đã cài, 2 = không nạp được `@playwright/test`. Thiếu module là lỗi
# dependency/`pnpm install`, không phải thiếu bước cấp browser — gộp chung sẽ
# chỉ sai chỗ cần sửa.
chromium_is_cached() {
  node -e '
    const fs = require("node:fs");
    let chromium;
    try {
      ({ chromium } = require("@playwright/test"));
    } catch {
      process.exit(2);
    }
    process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);
  '
}

if [ "${CI:-}" = "true" ]; then
  status=0
  chromium_is_cached || status=$?

  case "$status" in
    0)
      echo "Playwright chromium already provisioned by the CI job step; skipping install."
      exit 0
      ;;
    2)
      echo "Playwright module '@playwright/test' could not be loaded in this checkout; run 'pnpm install' before the test target. This is a missing or broken dependency, not a missing browser binary (issue #253)." >&2
      exit 2
      ;;
    *)
      echo "Playwright chromium is missing on CI. The integration-test job must run 'npx playwright install --with-deps chromium' before Nx starts (see .github/workflows/ci.yaml); this script deliberately does not install or apt-get from inside a parallel Nx task (issue #253)." >&2
      exit 1
      ;;
  esac
fi

# ⚠️ `timeout`: `set -euo pipefail` chỉ bắt exit code khác 0, không xử lý tiến
# trình treo vô hạn (mạng đứt, DNS chậm, registry không phản hồi) — không có
# timeout thì target `test-integration` treo luôn và khoá CI worker. Nới hạn:
# tải chromium (~170MB) trong 300s.
timeout 300 npx playwright install chromium
