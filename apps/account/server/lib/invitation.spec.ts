/**
 * Unit test cho `server/lib/invitation.ts` — hằng policy của kênh lời mời và
 * đường sinh `sub` mới (ADR-0030).
 *
 * Các hàm persistence (`issueInvitation`, `acceptInvitationAndCreateAccount`,
 * `findOpenInvitation`, `recordAcceptanceRejection`) là transaction trên
 * PostgreSQL thật với trigger và partial UNIQUE index — chúng được test ở tầng
 * database (`tests/databases/invitations.spec.ts`) và integration
 * (`tests/integrations/invitation-acceptance-e2e.spec.ts`). Ở đây neo những giá
 * trị là **hợp đồng policy** và đường thuần duy nhất của lib: sinh `sub`.
 */

import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_EMAIL } from '../../db/bootstrap.mts';
import { isSubject } from '@ecoma-io/account-domain';

import {
  createInvitedSubject,
  INVITATION_AUDIT_TYPE,
  INVITATION_EXCLUDED_ADDRESS,
  INVITATION_TTL_SECONDS,
  INVITED_SUBJECT_ENTROPY_BYTES,
} from './invitation';

describe('invitation policy constants', () => {
  it('locks the invitation channel policy numbers', () => {
    expect(INVITATION_TTL_SECONDS).toBe(7 * 24 * 3600);
    expect(INVITATION_AUDIT_TYPE).toBe('invitation_account_provisioned');
    expect(INVITED_SUBJECT_ENTROPY_BYTES).toBe(20);
  });

  it('pins the excluded address to the bootstrap email', () => {
    // Hai hằng sống ở hai file vì serving path không import được `bootstrap.mts`
    // (node builtin). Lệch giá trị là mở kênh lời mời cho đúng địa chỉ mà
    // bootstrap đã dùng — test này đỏ trước khi kịp thành lỗ hổng.
    expect(INVITATION_EXCLUDED_ADDRESS).toBe(BOOTSTRAP_EMAIL);
    expect(INVITATION_EXCLUDED_ADDRESS).toBe('superadmin@ecoma.io');
  });
});

describe('createInvitedSubject', () => {
  it('produces a valid subject with 160-bit lowercase base32 entropy', () => {
    const sub = createInvitedSubject();
    expect(isSubject(sub)).toBe(true);
    expect(sub.startsWith('sub_')).toBe(true);
    expect(sub).toHaveLength(4 + 32);
    // Alphabet base32 viết thường của `createSubject` — chữ HOA của
    // `base32Encode` phải được hạ trước khi nối.
    expect(sub.slice(4)).toMatch(/^[a-z2-7]{32}$/u);
  });

  it('yields distinct subjects across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      seen.add(createInvitedSubject());
    }
    expect(seen.size).toBe(32);
  });

  it('is deterministic for a fixed random source', () => {
    const bytes = new Uint8Array(20);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i;
    }
    const sub = createInvitedSubject((array) => array.set(bytes));
    expect(sub).toBe(createInvitedSubject((array) => array.set(bytes)));
    expect(isSubject(sub)).toBe(true);
  });
});
