# Auth Nonce Prune Job — Kiến trúc (ứng dụng)

> Phạm vi: boundary, thuật toán, caps, phân loại lỗi, permission model và invariants của `auth-nonce-prune-job`. Deploy/cron/runbook → [`03-operations.md`](./03-operations.md) · platform fact Hyperdrive / trần cron → `docs/architecture/04-platform-facts.md` · retention học thuyết (vì sao xoá theo `expires_at`, không xoá trắng) → [`01-architecture.md`](./01-architecture.md) §1 và §10.

## 1. Mục đích

Worker dọn nonce hết hạn của đường envelope HMAC nội bộ cho hai database:

```text
Cloudflare Cron (17 3 * * *)
       │
       ▼
auth-nonce-prune-job (module Worker, chỉ scheduled(), KHÔNG fetch)
   ├── Hyperdrive DB_AUTH    → db-auth    → DELETE auth.auth.internal_nonces
   │     (hai bảng đúng        └── role ecoma_auth_nonce_pruner
   │      trỏ tới)               DELETE account.internal_nonces
   │     └── role ecoma_account_nonce_pruner
```

Job là port TypeScript của `PRUNE_SCRIPT` trong workflow cron GitHub cũ (file đã bị xoá khỏi `main` trong cùng PR này): toàn bộ biên và bất biến của script cũ được giữ nguyên, chỉ đổi (a) executor Docker/`psql` thành driver `pg` trên Hyperdrive, và (b) quỹ thời gian (ghim mới, phần §6).

Job giữ nguyên học thuyết xoá: chỉ xoá `expires_at < now()` (vị từ canonical của GET exting nonce store), không `TRUNCATE`, không xoá theo tuổi cố định, không sửa `expires_at`. Nonce nằm lại vẫn là nonce đã bị chiếm và vẫn chặn replay — việc dọn là vận hành, không phải biện pháp bảo mật.

## 2. Phạm vi

### 2.1 Trong phạm vi

1. Chạy đúng một lần mỗi cron tick: hai kho song song qua `Promise.allSettled`, mỗi kho một identity preflight, một vòng lô `DELETE` có trần, một probe khi chạm trần.
2. Log kết quả mỗi kho dạng JSON một dòng ra `console.log` (không throw).
3. Throw (đỏ cron) ở các đường fail-closed: `cap_hit` có backlog, lỗi transport hết `MAX_ATTEMPTS`, lỗi statement, identity sai, thiếu cấu hình.

### 2.2 Ngoài phạm vi

- Không cấp câu lệnh migration/DDL: file migration của hai kho vẫn chạy tại CI runner, không phải từ Worker (`docs/architecture/02-delivery.md` §6).
- Không sửa dòng nào trong bảng nonce ngoài `DELETE` theo vị từ `expires_at < now()`: không INSERT, UPDATE, TRUNCATE.
- Không chạm bảng nào khác, schema nào khác, database nào khác — chỉ đúng `auth.internal_nonces` và `account.internal_nonces`.
- Không giữ secret nào của `auth`/`account`: credential của Worker là cho chính role pruner của mỗi kho, sinh và rotate bên provisioning, không phải một secret dùng chung nào của app khác.
- Không vi phạm serving path: Worker này không đụng code Hono/Nuxt của hai app.
- KHÔNG thêm Job Gate, không gate G38KV; một run đỏ là tín hiệu đúng, gộp hai kho thành "có kho OK" là che đi một bên đã hỏng (§3.5).

## 3. Worker Boundary

- Chỉ có MỘT entrypoint: `scheduled`. Không có `fetch` export — Worker không HTTP (không route trong `wrangler.jsonc`, `workers_dev: false`). Export `fetch` bị cấm sẽ là một surface tấn công không có auth nào được định nghĩa trong tài liệu.
- Lỗi của handler `await` trực tiếp (không `ctx.waitUntil` cho đường chính): throw của `scheduled()` được ghi là status error của cron invocation — chỉ ra được ở Cron dashboard → Past events. `waitUntil` sẽ che một lỗi ra khỏi trạng thái đó. Đang tham chiếu runtime-apis doc của Cloudflare: `"the first ctx.waitUntil to fail will be observed and recorded as the status in the Cron Trigger Past Events table"` — dùng `await` trực tiếp cũng để cùng trạng thái đó.
- Một run = đúng một cron tick. Không state cục bộ, không D1, không advisory lock — tiến độ là dữ liệu còn lại trên từng database; run đứt giữa đường chạy lại vẫn an toàn (một lô idempotent theo vị từ thời gian).
- Cấu hình caps là hằng số gắn app, không override qua env — một override chưa review là một ngân sách tự điền (§6).

## 4. Permission model — role pruner của từng database

Worker không cầm credential `_migrator_` (quyền DDL không bao giờ là Worker secret — `docs/architecture/02-delivery.md` §6; script cũ chạy bằng migrator trên CI runner, nên không port thẳng được). Hai migration sinh một role pruner riêng cho mỗi kho (mỗi database một principal, thống nhất như "hai job đối xứng" của workflow cũ):

| Kho          | Role                         | Quyền trên bảng nonce              | Migration (tạo + grant)                                 |
| ------------ | ---------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `db-auth`    | `ecoma_auth_nonce_pruner`    | `SELECT, DELETE` một bảng duy nhất | `apps/auth/migrations/0014_nonce_pruner_role.sql`       |
| `db-account` | `ecoma_account_nonce_pruner` | `SELECT, DELETE` một bảng duy nhất | `apps/account/db/migrations/0007_nonce_pruner_role.sql` |

Cả hai: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`; `GRANT USAGE` trên schema; REVOKE `INSERT, UPDATE, TRUNCATE, TRIGGER, REFERENCES`. Không có `CREATE` trên schema nào. Credential của role này không vào Git và không vào `wrangler.jsonc` — nó sống trong config Hyperdrive trên account Cloudflare, được Hyperdrive truyền tới Worker qua `connectionString` của binding ở runtime (pattern `apps/account/server/utils/db.ts`).

⚠️ Role pruner chỉ được tồn tại đúng hai quyền này trên đúng một bảng: nới quyền runtime hoặc nới pruner để cron "chạy được" đều bị cấm — xoá một nonce còn hiệu lực là mở lại cửa sổ replay, đúng học thuyết `0010` của db-auth. Sweep quyền tương ứng: `apps/auth/migrations/README.md` §"Sweep kiểm tra quyền" (ô 2d) và `apps/account/db/README.md` (provisioning snippet + file tree).

## 5. Thuật toán — port nguyên văn từ `PRUNE_SCRIPT`

Thứ tự trong một `pruneTarget()` (một kho) — khớp từng đoạn của script cũ:

1. **Identity preflight** — hỏi từ chính server:

   ```sql
   SELECT current_user || '|' || CASE
     WHEN to_regclass('<schema>.internal_nonces') IS NULL THEN 'missing'
     WHEN has_table_privilege(to_regclass('<schema>.internal_nonces'), 'DELETE')
         THEN 'deletable'
     ELSE 'no-delete'
   END;
   ```

   So với expected identity của kho (`ecoma_auth_nonce_pruner|deletable` / `ecoma_account_nonce_pruner|deletable`) trước khi xoá hàng nào — DSN dán sai service chỉ được chặn tại đây, không âm thầm prune nhầm database. `to_regclass` NULL vì bảng thiếu về thấy `'missing'` — vẫn mismatch. Cố ý KHÔNG so tên database: tên không nằm trong repo để ghim; ranh giới service nằm ở role + sự tồn tại của bảng, cả hai hỏi được từ server.

2. **Vòng lô có trần** — mỗi lô là một transaction riêng đã commit:

   ```sql
   BEGIN;
   SET LOCAL statement_timeout = 60s;   -- SET LOCAL (HD5): vẫn sống trong txn
   SET LOCAL lock_timeout = 30s;
   WITH deleted AS (
     DELETE FROM <schema>.internal_nonces
      WHERE nonce = ANY (ARRAY(
        SELECT nonce FROM <schema>.internal_nonces
         WHERE expires_at < now() LIMIT 20000))
     RETURNING 1)
   SELECT count(*) FROM deleted;
   COMMIT;
   ```

   - Dừng bình thường: lô trả 0 (kho sạch), hoặc lô cuối trả < `BATCH_SIZE` (không thêm vòng chắc chắn trả 0).
   - `WHERE nonce = ANY (ARRAY(SELECT …))` ghim plan: planner chọn InitPlan trong SELECT con, rồi Index Scan trên pkey — đo được ở script cũ; kế hình `DELETE … USING` để planner tự chọn có thể xảy ra Hash Join + Seq Scan toàn bảng, mỗi lô O(N).

3. **Chạm trần phải probe** — trần chỉ chứng minh ta dừng sớm, không chứng minh còn backlog. Sau khi chạm trần chạy một phép `SELECT EXISTS(…) WHERE expires_at < now())` rẻ (đi qua index `expires_at`): còn backlog → `outcome=cap_hit` + **throw** (cron đỏ, fail closed — lần chạy kế tiếp tiếp tục từ chỗ còn lại); đã xoá vừa đủ lúc chạm trần → `ok` kèm `cap=`. Không chạm trần thì không tốn một vòng probe nào.

Chuẩn output của lô được ghim: phải là một số nguyên hợp lệ (`count(*)`), probe phải boolean, preflight phải row identity đúng shape — sai shape là `UnexpectedOutputError` → `outcome=unexpected_output`, không retry (thử lại chỉ lặp lại shape sai).

## 6. Caps và quỹ thời gian — bảng tính tổng

Hằng số tập trung trong application lib (`libs/auth-nonce-prune-job-application`, module `prune-caps.ts`; loader của Worker kiểm rồi re-export — không env override — override chưa review là một ngân sách tự điền, giống cách script cũ ghim trong script):

| Hằng                        | Giá trị                      | Nguồn                         |
| --------------------------- | ---------------------------- | ----------------------------- |
| `BATCH_SIZE`                | 20 000                       | Script cũ                     |
| `MAX_BATCHES`               | 50                           | Script cũ                     |
| `MAX_SECONDS`               | 400                          | Ghim mới — xem bảng dưới      |
| `MAX_ATTEMPTS`              | 3                            | Script cũ                     |
| `STATEMENT_TIMEOUT_SECONDS` | 60                           | Script cũ (giây trên một lô)  |
| `LOCK_TIMEOUT_SECONDS`      | 30                           | Script cũ                     |
| `CONNECT_TIMEOUT_SECONDS`   | 10                           | Script cũ (PGCONNECT_TIMEOUT) |
| backoff tuyến tính          | `attempt × 5` giây (5s, 10s) | Script cũ                     |

Vì sao `MAX_SECONDS` giảm từ 600 xuống 400. Trần của một invocation `scheduled()` là 15 phút = 900 giây wall-clock (Workers platform fact — Cron Trigger "15 min" duration; đây là trần cứng của runtime, khác với `timeout-minutes` 25 của workflow cũ). Bảng tính đường xấu nhất một kho:

```text
một call có bay retry trần   ≤ MAX_ATTEMPTS × (connect 10s + statement 60s
                             + lock 30s) + backoff 5s + 10s = 225s
điểm kiểm trần cuối cùng     ≤ MAX_SECONDS = 400s
một lô cuối chưa chạy hết    ≤ 225s
backlog probe                ≤ 225s
─────────────────────────────────────────────────────
tổng một kho                 ≤ MAX_SECONDS + 450 = 850s < 900s
```

Hai kho chạy song song (`Promise.allSettled`) nên tổng invocation là `max(kho1, kho2)` — không phải `sum` — nên một kho dưới 900s là đủ. Chừa 50 giây slack cho jitter của cron và phần tài nguyên chưa được bao trong bảng tính. Với script cũ `MAX_SECONDS=600` tổng là 1050s, vượt 900s — vì vậy con số này không là "giữ nguyên con số cũ", mà là ghim mới và có được chốt bằng test trong `config.spec.ts` của Worker.

⚠️ Trần này kiểm trước mỗi lô (cùng hình script cũ `SECONDS - started`): một lô bắt đầu ngay trước mốc vẫn chạy tới hết lô đó, và phần thừa đó nằm trong bảng tính (một lô cuối + probe ≤ 450s). Preflight cùng chiếm quỹ của trần này: một preflight treo như (3×retry + backoff) sẽ phần trước khi preflight bắt đầu là chiếm hết 225s — phần còn lại đủ cho vòng lô, sau đó probe chốt được bằng dòng `outcome=` trong log.

## 7. Phân loại lỗi và retry

`pg` throw một exception — phân loại theo SQLSTATE của nó (field `code`):

| Lớp                     | Nhận diện                                                                               | Retry?                                                     | When hết ngân sách          |
| ----------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------- |
| transport               | SQLSTATE kết nối (08000, 08001, 08003, 08004, 08006, 08007, 05P01, 57P01, 57P02, 57P03) | Có — tối đa `MAX_ATTEMPTS`                                 | `db_unreachable` + throw    |
| statement               | SQLSTATE khác (42501 thiếu quyền, 57014 `statement_timeout`, ràng buộc 23502/23505…)    | Không                                                      | `statement_failed` + throw  |
| transport (tầng driver) | exception `pg` không mang SQLSTATE (errno hệ thống — `ENOTFOUND`, `ECONNREFUSED`)       | Có                                                         | `db_unreachable` + throw    |
| unexpected              | `UnexpectedOutputError` (output sai shape — preflight/probe/lô máy phải shape)          | Không (`code=UNEXPECTED_OUTPUT` không thuộc transport set) | `unexpected_output` + throw |

- Script cũ phân loại theo exit code của psql (1 statement / 2 transport); hàm phân loại driver ở đây đo trực tiếp đúng lớp SQLSTATE của PostgreSQL — chính xác hơn "psql exit 1 ≈ exit 2"]: một lô đủ điều kiện `05P01` (`lock_timeout` là tình huống khoá tạm thời) được retry an toàn vì lô bị ROLLBACK — không có lô dở dang nào.
- `57014` không retry: một lô chậm giữ khoá đã đủ 60s — thử lại chỉ kéo dài giữ khoá.
- Backoff: `attempt × 5` giây, tiêm qua `Sleep` không busy-loop — WK4 tính trần invocation theo wall-clock, busy-loop đốt đúng quỹ đó.

## 8. Log và observability

Mỗi run in một dòng JSON một dòng mỗi kho qua `console.log`:

```json
{
  "event": "nonce_prune",
  "service": "auth",
  "outcome": "ok",
  "pruned": 12345,
  "batches": 3,
  "duration_s": 42,
  "retries": 1
}
```

Kho hỏng → `{"event":"nonce_prune_error","message":"service=auth outcome=… pruned=… batches=…"}` — message giữ nguyên shape log script cũ cho `message` filed, đủ để runbook đọc được mà không festa thêm field phân tích. Lần thử lại → `{"event":"nonce_prune_retry","service":"auth","what":"identity_check","attempt":2}`.

- `pruned`/`batches` trong mọi dòng là số đếm thật đã xoá tới thời điểm hỏng (một lô đã commit lô sau hỏng vẫn phải báo đúng số đã commit), không phải `0` cứng — log nói "chưa xoá gì" trong khi hàng trăm nghìn nonce đã biến mất là tín hiệu sai theo hướng nguy hiểm.
- Không nonce, không secret, không connection string, không thân request — projection của `DELETE` là `RETURNING 1` bọc CTE, chỉ `count(*)` ra tới client; connection string sống trong Hyperdrive binding, không qua env, và loader cấu hình chỉ nêu tên binding trong message lỗi (`config.ts`).
- `pool.on('error')` ghi `{event:"db_pool.idle_client_error"}` rồi nuốt — cùng hình của `attachPoolErrorHandler` bên `account`.

## 9. Architectural Invariants

| #     | Invariant                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PN-1  | KHÔNG có `fetch` export, KHÔNG route, KHÔNG `workers_dev` — một HTTP surface cần auth là một ranh giới mới không được tài liệu                                                        |
| PN-2  | Identity preflight hỏi TỪ server trước DELETE đầu; sai identity là `identity_mismatch` + throw, không xoá hàng nào                                                                    |
| PN-3  | Đúng vị từ `expires_at < now()`, KHÔNG `TRUNCATE`, KHÔNG xoá theo tuổi, KHÔNG sửa `expires_at`                                                                                        |
| PN-4  | Chỉ xoá theo lô đã commit với `SET LOCAL statement_timeout` + `lock_timeout` trong transaction (HD5); không SET cấp connection                                                        |
| PN-5  | Chỉ 3 cap: `BATCH_SIZE` / `MAX_BATCHES` / `MAX_SECONDS`; thiếu bất kỳ nào là hồi quy thuật toán                                                                                       |
| PN-6  | Chạm trần phải probe `EXISTS` — còn backlog thì throw; "ok" một lô đã chạm trần là báo sai                                                                                            |
| PN-7  | Retry chỉ cho lớp transport SQLSTATE + errno connect tầng driver, tối đa MAX_ATTEMPTS; statement-class và output sai shape không retry                                                |
| PN-8  | KHÔNG advisory lock, KHÔNG LISTEN/NOTIFY, KHÔNG PREPARE/DEALLOCATE (HD6)                                                                                                              |
| PN-9  | KHÔNG nonce/secret/connection string trong log — projection DELETE là `RETURNING 1` + count                                                                                           |
| PN-10 | Mỗi lô tự commit, chọn hàng theo thời gian — run đứt chạy lại vẫn an toàn (không có trạng thái tiến độ nào để hỏng)                                                                   |
| PN-11 | KHÔNG `ctx.waitUntil` cho đường chính — await trực tiếp để throw của handler là status của cron invocation                                                                            |
| PN-12 | Xoá một ngày mỗi kho; hai kho chạy song song qua `Promise.allSettled`; error của một kho không cản kho kia chạy/log; run tổng đỏ nếu bất kỳ kho nào throw                             |
| PN-13 | Caps là hằng số app, KHÔNG override qua env (`docs/architecture/02-delivery.md` §6 — một override chưa review là một ngân sách tự điền)                                               |
| PN-14 | Role pruner đúng hai quyền trên đúng một bảng mỗi kho; KHÔNG nới quyền runtime; REVOKE phòng thủ nằm trong migration                                                                  |
| PN-15 | Không advisory-lock query-cache concern: DELETE là mutation không được cache (Hyperdrive caches eligible reads only), probe EXISTS đi qua cùng một binding — còn backlog thì đọc sống |

## 10. Unresolved

- Hyperdrive config thật của hai database chưa được provision. Binding `DB_AUTH` / `DB_ACCOUNT` trong `apps/auth-nonce-prune-job/wrangler.jsonc` mang id placeholder (toàn số 0) cho cả top-level lẫn hai lane `staging`/`production`, theo đúng pattern `apps/account/wrangler.jsonc` cho tới khi provisioning cấp id thật. Deploy lúc này sẽ fail-closed ở runtime (binding missing → throw `not_configured` mỗi cron tick) — đúng trạng thái phải báo đỏ, KHÔNG một run "bỏ qua lặng lẽ".
- Migration `0014` / `0007` chưa được apply her DB chưa tồn tại. Cho tới khi chạy trên database thật, hai role pruner chỉ tồn tại trong migration.
- `MAX_SECONDS=400` là ghim mới và CHƯA load-test. Bảng tính §6 là phân tích hết đường xấu nhất trên giấy, KHÔNG hề được chứng minh bằng một run thực tế. Khi deploy production thật, tick đầu tiên phải được quan sát ở Cron Past Events + `wrangler tail` để xác nhận: (a) identity preflight trả đúng `deletable`, (b) một lô 20 000 không quá 60s trên bảng thật, (c) tổng duration một run thường trực nằm dưới 400s hoặc `cap_hit`.
- Tần suất một ngày là chính sách vận hành khởi động — thấy backlog thường trực (cap_hit lặp lại nhiều ngày) thì docker-review nhịp cron, không đổi thuật toán (§3).
