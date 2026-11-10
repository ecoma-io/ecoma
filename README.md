# Ecoma.io

Repository của nền tảng Ecoma.io: nhiều bounded context và deploy unit chạy trên Cloudflare Workers, tổ chức theo Nx monorepo.

## Bắt đầu

- **Đóng góp** → [`CONTRIBUTING.md`](CONTRIBUTING.md) — điểm bắt đầu cho developer, coding agent và người review: cần đọc gì, tạo Issue thế nào, PR được merge khi nào.
- **Tài liệu hệ thống** → [`docs/README.md`](docs/README.md) — bản đồ bốn view `architecture/`, `domains/`, `applications/`, `features/` và quá trình kỹ thuật.
- **Quy trình kỹ thuật** → [`docs/engineering/`](docs/engineering/README.md) — vòng đời, quản lý công việc trên GitHub và cách đóng góp.

> For AI Agents Read [`AGENTS.md`](AGENTS.md) — kiến trúc không thương lượng, ngôn ngữ, quy tắc PR và merge.

## Quy trình tóm tắt

Mọi thay đổi kỹ thuật đi qua một quy trình thống nhất cho người và agent; không phải thay đổi nào cũng cần Issue hay Milestone. Năm bước dưới đây là bản rút gọn — vòng đời canonical có bảy bước:

1. Hiểu context và xác định Issue Type — Discovery, Modelling, Experiment, Delivery hoặc Remediation ([`work-management.md`](docs/engineering/work-management.md) §2.3).
2. Search Issue/PR; tái sử dụng, liên kết hoặc tạo work item mới khi công việc độc lập theo dõi được.
3. Tạo branch và draft PR khi công việc đã đủ rõ.
4. Chạy validation phù hợp với loại thay đổi và báo cáo kết quả thật.
5. Merge qua merge queue, rồi reconcile và đóng Issue khi đủ điều kiện.

Chi tiết → [`docs/engineering/contribution-workflow.md`](docs/engineering/contribution-workflow.md).
