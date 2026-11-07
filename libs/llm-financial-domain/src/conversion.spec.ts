/**
 * Ghim EC → UC conversion: ADR-0005 (irreversible, exactly-once, dual
 * authorization) và ADR-0004 (hai denomination domain không bao giờ trộn).
 *
 * Conversion ratio và fee là OPEN — test chỉ ghim cách lib xử lý ratio do caller
 * cấp, không ghim một policy nào.
 */

import { describe, expect, it } from 'vitest';

import { locateWallet } from './book';
import { convertEcToUc, findConversion } from './conversion';
import type { ConversionAuthorizationEvidence } from './records';
import { reserve } from './reservation';
import { createTestBook, ec, failureCode, IDS, NOW, unwrap } from './test-fixtures';

/** Evidence hợp lệ khớp actor/tenant của fixture. */
const EVIDENCE: ConversionAuthorizationEvidence = Object.freeze({
  actor_ref: 'actor-1',
  seller_tenant: 'tenant-seller',
  console_tenant: 'tenant-console',
  same_identity: true,
  seller_payout_authorized: true,
  console_payment_authorized: true,
  evaluated_at: NOW,
});

/** Input conversion mặc định: 1 EC → 2 UC. */
function input(overrides?: Partial<Parameters<typeof convertEcToUc>[1]>) {
  return {
    conversionId: 'cnv-1',
    actorRef: 'actor-1',
    sourceSellerTenant: 'tenant-seller',
    destinationConsoleTenant: 'tenant-console',
    sourceWalletId: IDS.ecWallet,
    destinationWalletId: IDS.ucWallet,
    sourceAmount: ec(100n),
    ratio: { numerator: 2n, denominator: 1n },
    authorization: EVIDENCE,
    convertedAt: NOW + 1,
    fencingToken: IDS.ecFence,
    destinationFencingToken: IDS.ucFence,
    ...overrides,
  };
}

/** Balance hiện tại của một wallet trong book. */
function balances(book: ReturnType<typeof createTestBook>['book'], walletId: string) {
  return unwrap(locateWallet(book, walletId as never)).wallet.balances;
}

describe('convertEcToUc', () => {
  it('moves value from EC available to UC available in two balanced transactions', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    const outcome = unwrap(convertEcToUc(book, input()));
    expect(balances(outcome.book, IDS.ecWallet).available.minor).toBe(900n);
    expect(balances(outcome.book, IDS.ucWallet).available.minor).toBe(200n);
    expect(outcome.conversion.source_amount.minor).toBe(100n);
    expect(outcome.conversion.target_amount.minor).toBe(200n);
    expect(outcome.conversion.ratio.numerator).toBe(2n);
    expect(outcome.book.conversions).toHaveLength(1);
  });

  it('records the ratio immutably on the conversion', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    const outcome = unwrap(convertEcToUc(book, input()));
    expect(outcome.conversion.ratio).toEqual({ numerator: 2n, denominator: 1n });
    expect(Object.isFrozen(outcome.conversion.ratio)).toBe(true);
  });

  it('is exactly-once by conversion id: replay returns the original record', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    const first = unwrap(convertEcToUc(book, input()));
    const replay = unwrap(convertEcToUc(first.book, input()));
    expect(replay.replayed).toBe(true);
    expect(replay.conversion.conversion_id).toBe('cnv-1');
    expect(replay.book.ledger.transactions).toHaveLength(first.book.ledger.transactions.length);
  });

  it('rejects a replayed conversion id with a different payload', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    const first = unwrap(convertEcToUc(book, input()));
    expect(failureCode(convertEcToUc(first.book, input({ sourceAmount: ec(101n) })))).toBe(
      'idempotency_conflict',
    );
  });

  it('rejects a replay that reuses another subject or tenant under the same id', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    const first = unwrap(convertEcToUc(book, input()));
    // Cùng `conversionId` nhưng khác actor: trả bản ghi gốc sẽ đưa record của
    // người khác cho caller này như một replay hợp lệ.
    expect(
      failureCode(
        convertEcToUc(
          first.book,
          input({
            actorRef: 'actor-2',
            authorization: { ...EVIDENCE, actor_ref: 'actor-2' },
          }),
        ),
      ),
    ).toBe('idempotency_conflict');
  });

  it('has no reverse operation — the public surface exposes only the one-way conversion', async () => {
    const module = await import('./conversion');
    expect(Object.hasOwn(module, 'convertUcToEc')).toBe(false);
  });

  it('fails closed when authorization evidence is missing', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(failureCode(convertEcToUc(book, input({ authorization: null as never })))).toBe(
      'conversion_authorization_missing',
    );
  });

  it('fails closed when any authorization flag is not true', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(
      failureCode(
        convertEcToUc(
          book,
          input({
            authorization: { ...EVIDENCE, seller_payout_authorized: false } as never,
          }),
        ),
      ),
    ).toBe('conversion_authorization_mismatch');
  });

  it('fails closed when the evidence belongs to another actor or tenant', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(
      failureCode(
        convertEcToUc(
          book,
          input({ authorization: { ...EVIDENCE, console_tenant: 'tenant-other' } as never }),
        ),
      ),
    ).toBe('conversion_authorization_mismatch');
  });

  it('rejects a ratio that does not produce an exact integer amount', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(
      failureCode(convertEcToUc(book, input({ ratio: { numerator: 1n, denominator: 3n } }))),
    ).toBe('conversion_not_exact');
  });

  it('rejects a non-positive ratio', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(
      failureCode(convertEcToUc(book, input({ ratio: { numerator: 1n, denominator: 0n } }))),
    ).toBe('invalid_conversion_ratio');
    expect(
      failureCode(convertEcToUc(book, input({ ratio: { numerator: 0n, denominator: 1n } }))),
    ).toBe('invalid_conversion_ratio');
  });

  it('rejects converting more EC than is available', () => {
    const { book } = createTestBook({ ecAmount: 50n, ucAmount: 0n });
    expect(failureCode(convertEcToUc(book, input({ sourceAmount: ec(51n) })))).toBe(
      'conversion_source_unavailable',
    );
  });

  it('rejects converting EC that is held by an escrow', () => {
    const { book } = createTestBook({ ecAmount: 100n, ucAmount: 0n });
    const held = reserveEc(book, 100n);
    expect(failureCode(convertEcToUc(held, input({ sourceAmount: ec(100n) })))).toBe(
      'conversion_source_unavailable',
    );
  });

  it('rejects a zero or negative source amount', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(failureCode(convertEcToUc(book, input({ sourceAmount: ec(0n) })))).toBe(
      'invalid_amount',
    );
  });

  it('rejects a UC source wallet or an EC destination wallet', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(
      failureCode(
        convertEcToUc(
          book,
          input({ sourceWalletId: IDS.ucWallet, destinationWalletId: IDS.ecWallet }),
        ),
      ),
    ).toBe('invalid_conversion');
    expect(failureCode(convertEcToUc(book, input({ destinationWalletId: IDS.ecWallet })))).toBe(
      'invalid_conversion',
    );
  });

  it('rejects a stale destination fencing token', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    expect(failureCode(convertEcToUc(book, input({ destinationFencingToken: 'fence-old' })))).toBe(
      'stale_fencing_token',
    );
  });

  it('finds a recorded conversion and reports a missing one', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 0n });
    const outcome = unwrap(convertEcToUc(book, input()));
    expect(unwrap(findConversion(outcome.book, 'cnv-1' as never)).target_amount.minor).toBe(200n);
    expect(failureCode(findConversion(outcome.book, 'missing' as never))).toBe(
      'invalid_conversion',
    );
  });
});

/** Reserve EC qua reservation — cần để chứng minh held EC không convert được. */
function reserveEc(book: ReturnType<typeof createTestBook>['book'], amount: bigint) {
  return unwrap(
    reserve(book, {
      reservationId: 'rsv-ec',
      walletId: IDS.ecWallet,
      billingAccountId: IDS.sellerAccount,
      amount: ec(amount),
      createdAt: NOW,
      fencingToken: IDS.ecFence,
    }),
  ).book;
}
