/**
 * Scope cua API key machine credential trong bounded context `remote-cache`.
 *
 * Nguon rang buoc:
 * - `applications/remote-cache/02-requirements.md` R2/R3: key phai project-scoped,
 *   co phan quyen read/write; read-only key khong duoc ghi; credential cua
 *   project nay khong cham cache cua project khac.
 * - ADR-0015: scope chi read/write per project — **khong** phan mirrors
 *   permission catalog cua staff-access (two vocabularies khac nhau, tron la
 *   bien scope phinh va tao ao giac "token hop le = duoc phep", A22 pattern).
 *
 * Hinh: scope phan tach dau cach trong mot cot text (pattern
 * `pact.machine_tokens.scopes`) — `read`, `write`, hoac `read write`.
 */

/** Tap scope hop le cua mot API key. */
export const REMOTE_CACHE_API_KEY_SCOPES = ['read', 'write'] as const;

/** Union type cua scope — dung cho contract va validator. */
export type RemoteCacheApiKeyScope = (typeof REMOTE_CACHE_API_KEY_SCOPES)[number];

/**
 * Regex khep mot chuoi scopes o lop **format**: tung token phai la `read`
 * hoac `write`, phan tach dung mot dau cach. Chuoi rong **khong** khep —
 * token khong scope nao la vo dung (R2: khong scope = vo dung).
 *
 * Pattern nay khong chinh tat lap token (`read read` format hop le) — DB
 * CHECK gap dung pattern nay, con quy tac **khong lap** do
 * {@link isRemoteCacheApiKeyScopeList} thuc thi o lop nguong app. Mot CHECK
 * regex duy nhat de tu choi lap can lookaround/behaviour thu tu cua
 * PostgreSQL regex khong don gian bang hinh tap: de hai lop chia viec.
 */
export const REMOTE_CACHE_API_KEY_SCOPE_PATTERN = '^(read|write)( (read|write))*$' as const;

/**
 * Kiem mot gia tri chuoi co phai chuoi scopes hop le khong: format khep
 * {@link REMOTE_CACHE_API_KEY_SCOPE_PATTERN} cong quy tac khong lap token
 * (`read read` bi tu choi) — dung boi validator contract; DB CHECK gap dung
 * pattern format, quy tac khong lap do lop nguong app giu.
 */
export function isRemoteCacheApiKeyScopeList(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  const parts = value.split(' ');
  return (
    parts.every((scope) => (REMOTE_CACHE_API_KEY_SCOPES as readonly string[]).includes(scope)) &&
    new Set(parts).size === parts.length
  );
}

/**
 * Kiem mot tap scopes (da parse) co chua quyen `write` khong — duong authorize
 * write-side cua serving path (P4.2) se dung helper nay thay vi tu parse.
 */
export function hasRemoteCacheWriteScope(scopes: readonly string[]): boolean {
  return scopes.includes('write');
}
