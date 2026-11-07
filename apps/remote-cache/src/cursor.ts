/**
 * Ma hoa/giai ma cursor keyset cho cac endpoint list cua control plane.
 *
 * Cursor la JSON `{ axis, at, id }` ma hoa base64url (pattern
 * `apps/staff-access/src/cursor.ts`). Endpoint list project dung truc keyset
 * `(created_at, id)` ASC — truong `axis` gan token voi truc cua no, mot
 * token dung sai endpoint thi decode ra khong khop axis va bi 400 thay vi
 * tra trang sai thu tu.
 *
 * Gia tri tren day la OPAQUE: consumer KHONG duoc doc/xay dung cursor
 * (contract list chi ghim `next_cursor: string | null`).
 */
export type KeysetCursorAxis = 'project-created-at';

export interface KeysetCursor {
  readonly axis: KeysetCursorAxis;
  readonly at: string;
  readonly id: string;
}

/** Encode mot cursor keyset thanh token base64url khong padding. */
export function encodeKeysetCursor(cursor: KeysetCursor): string {
  const payload = JSON.stringify({ axis: cursor.axis, at: cursor.at, id: cursor.id });
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Giai ma token cursor — `null` khi token sai hinh bat ky (khong base64,
 * khong JSON, thieu truong, sai kieu, sai axis) nen caller tra 400 thay vi doan.
 */
export function decodeKeysetCursor(token: string, axis: KeysetCursorAxis): KeysetCursor | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) {
    return null;
  }
  let binary: string;
  try {
    const padded = token + '='.repeat((4 - (token.length % 4)) % 4);
    binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.axis !== axis ||
    typeof record.at !== 'string' ||
    record.at === '' ||
    typeof record.id !== 'string' ||
    record.id === ''
  ) {
    return null;
  }
  return { axis, at: record.at, id: record.id };
}
