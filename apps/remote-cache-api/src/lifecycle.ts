/**
 * Cache cau hinh lifecycle (trang thai tenant/project) voi TTL ngan cho duong
 * doc, va re-check tai write duong (P4.4, issue #462).
 *
 * Nguyen tac duoc chot (roadmap §Open decisions + dinh duoc P4.4):
 *   - **Doc (read path):** luon re-check trang thai lifecycle tu DB de tu choi
 *     neu trang thua chua biet hoac khong active (fail-closed). Cache van duoc
 *     luu nhung KHONG duoc phep bo qua kiem tra DB tren duong doc — cache sot
 *     thua khong duoc bien suspend/delete thanh allow.
 *   - **Ghi (write path):** luon re-check trang thai lifecycle tu DB (bat bo
 *     cache). Neu trang thua chua biet -> fail-closed (tu choi ghi).
 *
 * Module nay chua cache trong bo nho cua isolate (khong giu socket, khong I/O
 * ngoai cac goi DB duoc caller truyen vao).
 */

import {
  isRemoteCacheTenantStatus,
  isRemoteCacheTenantStatusActive,
  remoteCacheDomainError,
} from '@ecoma-io/remote-cache-domain';
import { getTenantById, type RemoteCacheClient } from '@ecoma-io/remote-cache-infrastructure';

/** TTL cua cache lifecycle (ms) — ngan de cau hinh da cap nhat nhanh lan hieu luc. */
export const LIFECACHE_TTL_MS = 60_000;

/** Mot entry trong cache lifecycle. */
interface LifecycleEntry {
  readonly status: string;
  readonly expiresAt: number;
}

/** Cache trang thai tenant theo isolate (in-memory, khong giu socket). */
export class TenantLifecycleCache {
  private readonly cache = new Map<string, LifecycleEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = LIFECACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Tra trang thai tenant neu co trong cache va chua het han, nguoc lai null. */
  get(tenantId: string): string | null {
    const entry = this.cache.get(tenantId);
    if (entry === undefined) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(tenantId);
      return null;
    }
    return entry.status;
  }

  /** Luu trang thai tenant vao cache. */
  set(tenantId: string, status: string): void {
    this.cache.set(tenantId, { status, expiresAt: Date.now() + this.ttlMs });
  }

  /** Xoa entry khoi cache (dung khi can ap dung trang thai moi luon). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

/** Lay trang thai tenant tu DB — duong re-check tai write duong. */
export async function getTenantStatusFromDb(
  db: RemoteCacheClient,
  tenantId: string,
): Promise<string | null> {
  try {
    const tenant = await getTenantById(db, tenantId);
    return tenant?.status ?? null;
  } catch {
    throw remoteCacheDomainError('tenant_lookup_failed');
  }
}

/** Kiem trang thai tenant co phep doc/ghi khong (fail-closed neu null hoac khong active). */
export function isTenantLifecycleAllowed(status: string | null): boolean {
  return (
    status !== null && isRemoteCacheTenantStatus(status) && isRemoteCacheTenantStatusActive(status)
  );
}

/** Xac thuc trang thai tenant, fail-closed. Tra tenantStatus neu duoc phep, nem domain error neu bi tu choi. */
export async function enforceTenantLifecycle(
  db: RemoteCacheClient,
  tenantId: string,
  _useCache: boolean,
): Promise<string> {
  // Luon lay trang thai tu DB de tranh cache sot thua su dung da duoc xoa hoat
  // dong. KHONG cache trang thai tenant: cache sot thua co the bien
  // suspend/delete thanh allow (fail-closed, finding Phase A: tenantLifecycleCache
  // dead code removed).
  const status = await getTenantStatusFromDb(db, tenantId);

  if (!isTenantLifecycleAllowed(status)) {
    const code =
      status === 'suspended'
        ? 'tenant_suspended'
        : status === 'deleted'
          ? 'tenant_deleted'
          : 'tenant_not_found';
    throw remoteCacheDomainError(code);
  }

  return status as string;
}
