# ADR-0035 — Session store của portal BFF `remote-cache-app`: database riêng `db-remote-cache-app`

> **Trạng thái:** Accepted · **Ngày:** 2026-11-15 · **Nguồn:** [#180](https://github.com/ecoma-io/ecoma/issues/180) (hiện thực, merge qua PR #291) · [`../../../applications/remote-cache/02-requirements.md`](../../../applications/remote-cache/02-requirements.md) R16 · [`../../../applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §12

> ⚠️ **Bản ghi hồi tố.** Hiện thực (#180, PR #291) đã đưa migration `0001_remote_cache_app_bff_sessions.sql` và configuration `db-remote-cache-app` vào PR trước khi ADR này được viết. ADR này ghi nhận lại quyết định của hiện thực và đồng thời **sửa điều khoản owner trong R16** (trước đây: "session store owner là `account` — portal MUST NOT tự sở hữu session state"); R16 và §12 của `01-architecture.md` đã được cập nhật theo trong cùng PR.

## Bối cảnh

R16 (bản gốc) yêu cầu portal BFF giữ token server-side, nhưng gán **owner của session store là `account`** và cấm portal tự sở hữu session state. Điều khoản này không thể hiện thực đúng chữ:

- **Account không có contract cross-app session store.** `apps/account` không expose bất kỳ API hay event contract nào cho phép một BFF khác đọc/ghi phiên đăng nhập của nó. Không có gì để portal dùng.
- **Route portal sessions vào `db-account` vi phạm invariants 5, 7 và 25** của [`docs/architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9: mỗi service sở hữu tài nguyên database/storage của riêng mình; không service nào trực tiếp truy cập database của service khác. Portal ghi vào `db-account` là truy cập chéo database — cấm.

Pattern đã được chứng minh trên platform là **mỗi app BFF giữ session store của mình trong DB sở hữu bởi chính app đó**: pact-broker giữ session trong `db-pact-broker-app` ([ADR-0031](../../pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md) §2), backoffice giữ `bff_sessions` trong DB của domain nó phục vụ (`docs/applications/backoffice/01-architecture.md` §Runtime boundary). Portal đi theo cùng pattern.

Lưu ý phân loại: bảng `bff_login_flows` (state OIDC + PKCE, ephemeral, single-use) **không phải deviation** — mọi BFF OIDC phải giữ trạng thái login flow phía server; đây là điều kiện của OAuth 2.0 + PKCE server-side, không phải quyết định sở hữu dữ liệu. Deviation duy nhất là bảng session bền `bff_sessions`.

## Quyết định

- **Portal sở hữu database riêng `db-remote-cache-app`** (schema `remote_cache_app`, deployment unit `deploys/remote-cache-app-deploy`), chứa hai bảng:
  - `bff_login_flows` — trạng thái OIDC login flow (state, PKCE verifier, redirect), **ephemeral**, single-use, TTL ngắn;
  - `bff_sessions` — session browser của portal, bền theo TTL session.
- **Portal không cấp identity cục bộ.** Không có bảng user/local account; danh tính duy nhất của portal là principal Ecoma Account đã xác thực qua OIDC. Sự thật về identity và authentication vẫn thuộc `account`/`auth`.
- **Portal không bao giờ chạm `db-remote-cache`.** Truy cập control plane chỉ qua private service binding với envelope HMAC nội bộ ([ADR-0034](./0034-human-principal-control-plane-authorization.md)).
- **Token OAuth/OIDC chỉ nằm server-side** trong BFF, không bao giờ về browser; browser chỉ giữ `__Host-` session cookie tham chiếu `bff_sessions`.
- R16 được **sửa điều khoản owner**: session store của portal là của chính portal theo ADR này — thay cho "owner là `account`". Ràng buộc còn lại của R16 giữ nguyên.

## Hệ quả

- Invariants 5/7/25 được đáp ứng: mỗi deploy unit sở hữu database của mình; không có truy cập chéo.
- Portal cần migration và connection riêng (Hyperdrive/Pool) cho `db-remote-cache-app` — chi phí vận hành thêm một database nhỏ, chấp nhận vì pattern này đã chạy ở hai app BFF khác.
- Session của portal không có cơ chế single-logout tập trung với account; hết hạn theo TTL riêng và revoke khi token refresh thất bại. Không có yêu cầu SSO logout xuyên app trong M1.
- Nếu sau này platform cung cấp một contract session store dùng chung cho nhiều app, quyết định này có thể xem lại qua ADR mới — không đảo ngầm.

## Phân loại ephemeral vs durable

| Bảng              | Vòng đời                                                        | Tính chất                                                                                   |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bff_login_flows` | TTL giây, single-use, xoá khi flow hoàn tất/hết hạn             | Trạng thái kỹ thuật của handshake OIDC; mất thì người dùng đăng nhập lại, không mất dữ liệu |
| `bff_sessions`    | TTL session, gia hạn khi active, revoke khi logout/refresh fail | Phiên đăng nhập browser; mất thì người dùng đăng nhập lại, không mất dữ liệu domain         |

Cả hai đều là trạng thái phục vụ phiên — không phải dữ liệu domain của bounded context remote-cache; vì vậy chúng nằm trong database của portal, không phải `db-remote-cache`.
