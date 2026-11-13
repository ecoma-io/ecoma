#!/usr/bin/env bash
#
# Đảm bảo Playwright chromium sẵn sàng trước khi suite browser chạy bên trong
# target `test-integration` (06-testing.md — suite app-owned gắn vào
# test-integration, không phải target `e2e` riêng).
#
# Vì sao script này nằm trong suite mà không phải trong CI workflow: file
# workflow thuộc hạ tầng repo, không thuộc project `apps/backoffice`; để target
# tự cấp phụ thuộc trình duyệt thì project chạy được ở **mọi** nơi target chạy
# (CI runner mới, worktree khác, máy dev mới) mà không ai phải nhớ cài gì.
#
# Hai bước, mỗi bước một lý do riêng:
#
# 1. Binary chromium: `playwright install` theo **phiên bản** — cache theo
#    phiên bản đã có thì là no-op (nhanh), chưa có thì tải đúng bản khớp package.
# 2. Thư viện hệ điều hành: chỉ làm trên CI (`CI=true`) — runner hosted cần
#    `apt-get` qua sudo để đủ libs chromium, còn máy dev đã có sẵn (và tự ý chạy
#    `sudo apt-get` trên máy cá nhân là hành vi sai).
#
# Fail-loud: bước nào lỗi thì target đỏ tại bước đó, không nuốt lỗi để suite
# chạy với binary thiếu rồi đỏ ở chỗ mơ hồ hơn.

set -euo pipefail

cd "$(dirname "$0")/../.."

# ⚠️ Hai bước đều bọc `timeout`: `set -euo pipefail` chỉ bắt exit code khác 0,
# không xử lý tiến trình treo vô hạn (mạng đứt, DNS chậm, registry không phản
# hồi) — không có timeout thì target `test-integration` treo luôn và khoá CI
# worker. Nới hạn: tải chromium (~170MB) trong 300s; `install-deps` chạy
# `apt-get` trên CI runner nên cho 600s.
timeout 300 npx playwright install chromium

if [ "${CI:-}" = "true" ]; then
  timeout 600 npx playwright install-deps chromium
fi
