# LLM Inference E2E

Suite system-test **end-to-end thật trên lane local** (`@ecoma-io/llm-inference-e2e`, Issues #23/#24): chứng minh luồng inference Dronie → Ecoma chạy trọn vẹn trên hạ tầng đã deploy — từ readiness của worker và mock upstream, qua một `POST /v1/chat/completions` thật đi worker → marketplace → financial → mock upstream, đến trạng thái usage/quota/settlement/journal bền trong PostgreSQL, replay không double charge, auth thất bại ổn định và các fence không-leak.

Nx project `llm-inference-e2e`, tags `type:tooling`, `scope:llm-api`, `runtime:native`. Target canonical: `system-test` (06-testing.md §4).

## Chạy

```bash
pnpm nx run llm-inference-e2e:system-test -c local
```

Target kéo prerequisite theo `dependsOn`: `local-up` của `platform-deploy`, `account-deploy`, `staff-access-deploy` (gap #113 — `local-up` của llm-api-deploy đọc credential migrator cross-stack mà không khai dependsOn, suite bù cạnh ở đây) rồi `test-lane-up` của `llm-api-deploy` (hội tụ container mock upstream + serving config + `local.ts up`). `cache: false` là CONTRACT — stack là external state ngoài inputs của Nx.

## Wiring và kênh secret

- Suite KHÔNG TỰ deploy và KHÔNG đụng vòng đời container nào — lifecycle thuộc lane target của `deploys/llm-api-deploy`.
- Trạng thái lane đến qua `bin/run-system-test.mjs` → `lane.ts state` (spawn, không inherit stdout): envelope `LANE_STATE=<json>` một dòng mang namespace, network, owner sub superadmin và plaintext key consumer; runner nạp vào env `LLM_E2E_*` cho vitest.
- Plaintext key đi đúng MỘT đường: stack output bí mật → `lane.ts state` → env vitest → header `Authorization` của request. KHÔNG qua file, KHÔNG qua argv, KHÔNG qua log. Runner giữ fence cuối: captured output của suite chứa plaintext là fail và output bị giữ.
- Mọi probe/request HTTP chạy TRONG platform network qua container ephemeral (`support/client.mjs`, node pin digest, repo mount read-only) — PostgreSQL/worker/mock không publish cổng ra host.
- Toàn bộ kiểm tra database là SELECT read-only qua `docker exec` psql. Suite không migration, không seed, không chạy bootstrap.

## Readiness gate

`global-setup.ts` fail-closed (06-testing.md §2): probe `/health` → `/ready` của worker từ trong network, retry trong budget 180s cho các thất bại "chưa xong nhưng sẽ xong" (worker boot, `/ready` 503). Readiness của mock — vốn cần credential UPSTREAM (`llmUpstreamCredentialPlaintext`, worker gửi nó cho mock theo đúng contract bước 8b) mà suite cố ý không giữ — đã được gate bởi `test-lane-up` (waiter trong network, dependency target của `system-test`); kịch bản (f) chứng minh lại mock phục vụ kèm `auth=ok` qua log mock trên đường serving thật.

## Suite chứng minh gì (và không chứng minh gì)

Chứng minh trên hệ thống đã deploy: bootstrap lane đúng hợp đồng (superadmin sub một nguồn cho hai tenant; Dronie seller first_party với principal/case approved + attribution; đúng một provider credential hash-only; offer active trên pool healthy; consumer tenant với đúng một api key hash-only khớp SHA-256 của key lane; funding B1–B4 credited với escrow bảo toàn); catalogue + một serving thành công thật (envelope chuẩn, content deterministic của mock, usage thật, model = normalized_model_id); settled đúng một lần trên logical request/quota reservation/charge với "charged ≤ held" và journal metadata-only; replay cùng `x-request-id` → 409 `request_id_replay` không tạo dòng mới; auth thất bại (thiếu/sai hình/key lạ) → cùng lớp lỗi ổn định, không dấu vết ledger; fence không-leak trên log hai đầu và cột key_hash.

KHÔNG chứng minh ở đây — đã có bằng chứng ở tầng integration của `apps/llm-api` (`tests/integrations/`): ma trận lỗi upstream (`unauthorized`/`rate_limited`/`server_error`/`timeout`/`malformed` inject qua `x-mock-scenario`), race trần quota đồng thời, và ngữ nghĩa 409 `idempotency_conflict` khi cùng request-id với payload khác. Suite này chạy kịch bản happy-path + replay + auth-failure trên hệ thống thật; mở rộng ma trận lỗi trên lane là work riêng nếu cần.

## Cấu trúc

- `bin/run-system-test.mjs` — runner: đọc `LANE_STATE`, nạp env, chạy vitest, fence + forward output/exit code.
- `global-setup.ts` — readiness gate fail-closed trong network.
- `support/lane.mts` — accessor env, request in-network, psql read-only, docker logs, readiness probe.
- `support/client.mjs` — HTTP client thuần chạy trong container ephemeral (stdin JSON → một dòng JSON `{status, body}`).
- `e2e/01-lane-bootstrap.spec.ts` — (b)(c)(d) trạng thái bootstrap bền của lane.
- `e2e/02-serving-and-ledger.spec.ts` — (e)(f)(g)(h) serving thật + sổ cái + replay.
- `e2e/03-auth-failures.spec.ts` — (i) auth thất bại ổn định, không dấu vết.
- `e2e/04-leak-fences.spec.ts` — (j) fence không-leak trên log và DB.

## Hạn chế đã biết

- Plaintext key consumer show-once: `test-lane-up` skip `local.ts up` khi stack state đã mang key; xoá state Pulumi trong khi database còn giữ row key là runner bước 9 hội tụ `existing` và không bao giờ in lại — phục hồi bằng `local-down` đầy đủ rồi `test-lane-up` (chi tiết ở README của deploy unit).
- Container mock chưa nằm trong `CLEANUP_KINDS` của `tools/dx` (kind chưa vào union `DeployResourceKind` của `libs/deployment`) — dọn chính thức là `test-lane-down`; follow-up đã ghi ở README deploy unit.
- Worker phục vụ route không tiền tố `/llm` trong network (`/v1/*` trên alias `ecoma-llm-api:4211`); tiền tố `/llm` thuộc lớp routing edge production, không tồn tại trên lane local.

## Related Documentation

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — phân loại tầng test, target canonical, readiness gate.
- [`deploys/llm-api-deploy/README.md`](../../../deploys/llm-api-deploy/README.md) — lane E2E ownership, kênh secret, skip-converged.
- [`docs/applications/llm-api/README.md`](../../../docs/applications/llm-api/README.md) — contract HTTP serving mà suite ghim.
- [`docs/architecture/local-development/03-operations.md`](../../../docs/architecture/local-development/03-operations.md) — vận hành lane, kênh stdin cho credential.
