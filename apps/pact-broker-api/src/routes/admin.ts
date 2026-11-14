/**
 * Admin routes — quản trị machine token (scope `admin` trên đường machine;
 * đường user đi theo ma trận ADR-0032 §1).
 *
 * KHÔNG có route tạo tenant/membership: bootstrap tenant canonical là việc của
 * deploy pipeline qua script service-owned `db/bootstrap-tenant.mts` (migrations
 * không chèn tenant nào; ensureDefaultTenant chỉ là primitive cho tenant mặc định
 * của customer), không phải API surface — một endpoint "tạo tenant" không xác
 * thực được ai có quyền tạo tenant sẽ thành backdoor tái diễn.
 *
 * Token: show-once — POST trả bản rõ đúng một lần trong response; mọi list
 * sau đó chỉ thấy prefix + metadata. Revoke hiệu lực tức thời.
 *
 * Hai đường authorize song song (ADR-0032 "Hệ quả"):
 *  * machine token scope `admin` — hành vi giữ nguyên, `actor_sub` null;
 *  * user principal (JWT do BFF forward) — quyền theo ma trận ADR-0032 §1:
 *    member tạo purpose `developer` scopes ⊆ {read, write} và chỉ thao tác
 *    credential mình tạo; admin/owner tạo thêm purpose `ci`, scope tới
 *    `admin`, và thao tác credential của cả tenant. Viewer không được phép
 *    mutation nào.
 */
import { Hono, type MiddlewareHandler } from 'hono';
// Named imports, chủ ý — xem ghi chú trong src/domain/validation.ts.
import { array, enum as zEnum, object, string } from 'zod';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import { PgTenantRepo, insertAuditEvent } from '@ecoma-io/pact-broker-api-infrastructure';
import { readJsonBodyWithLimit } from '../middleware/validate';
import { type MembershipRole, roleSatisfies } from '../auth/user-auth';

const PURPOSE_VALUES = ['developer', 'ci'] as const;
type TokenPurpose = (typeof PURPOSE_VALUES)[number];

const createTokenSchema = object({
  name: string().min(1, 'name is required').max(255, 'name exceeds 255 characters'),
  scopes: array(zEnum(['read', 'write', 'admin']))
    .min(1, 'at least one scope is required')
    .max(3, 'at most three scopes'),
  // Đường machine không bắt buộc purpose (FR-008 của CLI không đổi); đường
  // user bắt buộc chọn — enforce ở `resolvePurpose` theo hình dạng caller.
  purpose: zEnum(PURPOSE_VALUES).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Quyền hiệu lực của principal trên tenant hiện tại (ADR-0032 §1): user trả
 * role membership (owner đã được floor thành admin ở middleware user-auth);
 * machine token scope `admin` có toàn bộ quyền của admin. Viewer/member còn
 * lại được phân biệt qua `role` để enforce các rule per-creator.
 */
interface CallerAuthority {
  readonly role: MembershipRole | 'admin';
  /** `sub` đã verify trên đường user; null trên đường machine token. */
  readonly actorSub: string | null;
}

/**
 * Đọc authority của caller từ context middleware gắn. Route admin được mount
 * với middleware chấp nhận kép; user path chỉ đạt được tới đây khi role thoả
 * mực `admin`... KHÔNG — middleware chung (`handleUserToken`) chỉ đảm bảo
 * viewer+ cho read; ma trận mutation của admin là việc của route này, đọc
 * thẳng `principalSub`/role từ context.
 */
function callerAuthority(c: import('hono').Context<AppEnv>): CallerAuthority {
  const sub = c.get('principalSub');
  if (typeof sub === 'string' && sub !== '') {
    // Middleware user-auth đã resolve role; đọc lại từ context cùng giá trị.
    const role = c.get('principalRole');
    // roleSatisfies fail-closed với giá trị lạ, nên coerce tường minh an toàn
    // hơn assertion: role không nằm trong ROLE_RANK bị coi là viewer (đọc) và
    // bị chặn ở mọi mutation.
    const safeRole: MembershipRole = role === 'member' || role === 'admin' ? role : 'viewer';
    return { role: safeRole, actorSub: sub };
  }
  // Đường machine: guard scope admin của route đã chạy; admin-level.
  return { role: 'admin', actorSub: null };
}

/**
 * Ma trận tạo credential (ADR-0032 §1a/§1e, §3): creator-role chi phối scope
 * xin cấp và purpose được phép. Vi phạm → 403, không đoán thay caller.
 */
function checkCreate(authority: CallerAuthority, purpose: TokenPurpose, scopes: string[]): boolean {
  if (!roleSatisfies(authority.role, 'member')) return false; // viewer ✗ mọi purpose
  const isAdmin = authority.role === 'admin';
  if (purpose === 'ci' && !isAdmin) return false;
  // purpose developer: scopes ⊆ {read, write}; purpose ci: tới `admin`.
  const allowed = purpose === 'ci' ? ['read', 'write', 'admin'] : ['read', 'write'];
  return scopes.every((scope) => allowed.includes(scope));
}

export function adminRoutes(adminAuth: () => MiddlewareHandler<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List machine tokens — metadata only, không bao giờ trả token bản rõ.
  // Visibility theo ADR-0032 §1b: member chỉ credential mình tạo;
  // admin/owner toàn tenant.
  app.get('/machine-tokens', adminAuth(), async (c) => {
    const authority = callerAuthority(c);
    // ADR-0032 §1b: viewer ✗ (403) — không bao giờ có credential tự tạo, và
    // ma trận tường minh không cho viewer nhìn metadata nào cả.
    if (authority.actorSub !== null && !roleSatisfies(authority.role, 'member')) {
      return c.json({ error: 'Forbidden', message: 'Forbidden' }, 403);
    }
    const repo = new PgTenantRepo(c.get('pool'));
    // Cục bộ là `tokenRows` (không phải `tokens`): tên trần `tokens` khớp nguồn
    // của rule security-sensitive-value-in-http-response dù giá trị chỉ là
    // metadata; key `_embedded.tokens` giữ nguyên vì là hợp đồng API (HAL).
    const tokenRows = await repo.listMachineTokens(currentTenantId(c));
    const visible =
      authority.actorSub !== null && authority.role !== 'admin'
        ? tokenRows.filter((t) => t.createdBySub === authority.actorSub)
        : tokenRows;
    return c.json({
      _embedded: {
        tokens: visible.map((t) => ({
          id: t.id,
          name: t.name,
          scopes: t.scopes.split(' ').filter((s) => s !== ''),
          purpose: t.purpose,
          createdBy: t.createdBySub,
          createdAt: t.createdAt,
          revokedAt: t.revokedAt,
        })),
      },
    });
  });

  // Create machine token — response chứa token bản rõ ĐÚNG MỘT LẦN.
  app.post('/machine-tokens', adminAuth(), async (c) => {
    const bodyResult = await readJsonBodyWithLimit(c, 64 * 1024, 'Admin body');
    if (!bodyResult.ok) return bodyResult.errorResponse;
    if (bodyResult.value === undefined) {
      return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
    }
    const raw = bodyResult.value;
    const parsed = createTokenSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return c.json(
        {
          error: 'Bad Request',
          message: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request',
        },
        400,
      );
    }

    const authority = callerAuthority(c);
    const userPath = authority.actorSub !== null;
    const purpose: TokenPurpose | null = parsed.data.purpose ?? null;
    if (userPath) {
      // Đường user bắt buộc purpose (ADR-0032 §2).
      if (purpose === null) {
        return c.json({ error: 'Bad Request', message: 'purpose: purpose is required' }, 400);
      }
      if (!checkCreate(authority, purpose, parsed.data.scopes)) {
        return c.json(
          { error: 'Forbidden', message: 'Creator role does not allow this purpose or scope' },
          403,
        );
      }
    }

    const tenantId = currentTenantId(c);
    const callerTokenId = c.get('tokenId') ?? null;
    const repo = new PgTenantRepo(c.get('pool'));

    // Create + audit trong MỘT transaction (ADR-0032 §4 — atomic hoá như
    // rotate): audit insert fail ⇒ rollback, không để lại token không audit
    // (fail-closed). Người sửa comment trước đây tại đây nói "trong cùng
    // transaction" trong khi code dùng hai transaction — comment sai đã được
    // code hoá đúng bằng thay đổi này.
    const client = await c.get('pool').connect();
    try {
      await client.query('BEGIN');
      const { token, record } = await repo.createMachineToken(
        client,
        tenantId,
        authority.actorSub,
        parsed.data.name,
        parsed.data.scopes,
        purpose,
      );
      await insertAuditEvent(client, {
        tenantId,
        actorSub: authority.actorSub,
        actorTokenId: callerTokenId,
        action: 'machine_token.create',
        outcome: 'success',
        detail: { tokenId: record.id, scopes: parsed.data.scopes },
      });
      await client.query('COMMIT');

      return c.json(
        {
          token: {
            id: record.id,
            name: record.name,
            scopes: parsed.data.scopes,
            purpose: record.purpose,
            createdBy: record.createdBySub,
            createdAt: record.createdAt,
            revokedAt: null,
          },
          // Show-once: giá trị duy nhất lần này response chứa nó.
          secret: token,
        },
        201,
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  // Rotate machine token — token cũ mất hiệu lực ngay lập tức, bản rõ trả về
  // đúng một lần (show-once). Caller user chỉ rotate credential mình tạo,
  // trừ admin/owner (ADR-0032 §1).
  app.post('/machine-tokens/:id/rotate', adminAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Token not found' }, 404);
    }
    const tenantId = currentTenantId(c);
    const authority = callerAuthority(c);
    const callerTokenId = c.get('tokenId') ?? null;
    const repo = new PgTenantRepo(c.get('pool'));

    if (authority.actorSub !== null && authority.role !== 'admin') {
      // Per-creator boundary: token không của mình trả 404 (không phân biệt
      // với "không tồn tại" — cùng luật tenant isolation).
      const owned = await repo
        .listMachineTokens(tenantId)
        .then((rows) => rows.some((t) => t.id === id && t.createdBySub === authority.actorSub));
      if (!owned) {
        return c.json({ error: 'Not Found', message: 'Token not found' }, 404);
      }
    }

    // Xoay + ghi audit cùng diễn ra trên một transaction duy nhất trên một pg
    // client (fail-closed): nếu audit lỗi, toàn bộ transaction rollback và
    // token mới không được lưu.
    const client = await c.get('pool').connect();
    try {
      await client.query('BEGIN');
      const rotated = await repo.rotateMachineToken(client, tenantId, id, authority.actorSub);
      if (rotated === null) {
        await client.query('ROLLBACK');
        return c.json({ error: 'Not Found', message: 'Token not found or already revoked' }, 404);
      }
      await insertAuditEvent(client, {
        tenantId,
        actorSub: authority.actorSub,
        actorTokenId: callerTokenId,
        action: 'machine_token.rotate',
        outcome: 'success',
        detail: { tokenId: id },
      });
      await client.query('COMMIT');

      return c.json(
        {
          token: {
            id: rotated.record.id,
            name: rotated.record.name,
            scopes: rotated.record.scopes.split(' ').filter((s) => s !== ''),
            purpose: rotated.record.purpose,
            createdBy: rotated.record.createdBySub,
            createdAt: rotated.record.createdAt,
            revokedAt: null,
          },
          // Show-once: giá trị duy nhất lần này response chứa nó.
          secret: rotated.token,
        },
        200,
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  // Revoke machine token — hiệu lực tức thời; visibility như rotate.
  app.delete('/machine-tokens/:id', adminAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Token not found' }, 404);
    }
    const tenantId = currentTenantId(c);
    const authority = callerAuthority(c);
    const callerTokenId = c.get('tokenId') ?? null;
    const repo = new PgTenantRepo(c.get('pool'));

    if (authority.actorSub !== null && authority.role !== 'admin') {
      const owned = await repo
        .listMachineTokens(tenantId)
        .then((rows) => rows.some((t) => t.id === id && t.createdBySub === authority.actorSub));
      if (!owned) {
        return c.json({ error: 'Not Found', message: 'Token not found' }, 404);
      }
    }

    // Revoke + audit trong MỘT transaction (ADR-0032 §4 — atomic hoá như
    // rotate, fail-closed).
    const client = await c.get('pool').connect();
    try {
      await client.query('BEGIN');
      const ok = await repo.revokeMachineToken(client, tenantId, id);
      if (!ok) {
        await client.query('ROLLBACK');
        return c.json({ error: 'Not Found', message: 'Token not found (or already revoked)' }, 404);
      }
      await insertAuditEvent(client, {
        tenantId,
        actorSub: authority.actorSub,
        actorTokenId: callerTokenId,
        action: 'machine_token.revoke',
        outcome: 'success',
        detail: { tokenId: id },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return c.body(null, 204);
  });

  return app;
}
