/**
 * Ghim public surface và các phân biệt khái niệm mà `01-architecture.md` §2 bắt
 * buộc: provider cost ≠ customer charge, seller payable ≠ payout, reservation ≠
 * charge, budget lease ≠ quota lease, unused escrow ≠ outstanding liability.
 *
 * Đây là test của **hình dạng API**, không phải của một operation cụ thể: chúng
 * bảo vệ việc "một khái niệm không bị trộn vào chỗ khác" khi lib tiếp tục phát
 * triển.
 */

import { describe, expect, it } from 'vitest';

import * as financial from './index';
import { locateWallet } from './book';
import { openEscrow, issueLease } from './escrow';
import { accruePayable } from './payable';
import { reserve } from './reservation';
import { createTestBook, day, ec, IDS, NOW, uc, unwrap } from './test-fixtures';

describe('public surface', () => {
  it('does not expose any provider cost model — ownership of provider cost is OPEN', () => {
    const providerNames = Object.keys(financial).filter((name) =>
      /provider.*cost|cost.*provider/iu.test(name),
    );
    expect(providerNames).toEqual([]);
  });

  it('does not expose payout execution or fiat disbursement', () => {
    const payoutExecutionNames = Object.keys(financial).filter((name) =>
      /^(executePayout|disburse|sendPayout|payOutFiat)/u.test(name),
    );
    expect(payoutExecutionNames).toEqual([]);
  });

  it('does not expose tax calculation or withholding rates', () => {
    const taxNames = Object.keys(financial).filter((name) => /tax|withhold/iu.test(name));
    expect(taxNames).toEqual([]);
  });

  it('does not expose an EC to UC reverse conversion', () => {
    expect(Object.hasOwn(financial, 'convertUcToEc')).toBe(false);
  });

  it('does not expose ledger update or delete', () => {
    expect(Object.hasOwn(financial, 'updateLedgerEntry')).toBe(false);
    expect(Object.hasOwn(financial, 'deleteLedgerEntry')).toBe(false);
    expect(Object.hasOwn(financial, 'reverseTransaction')).toBe(false);
  });
});

describe('concept distinctions', () => {
  it('a reservation holds money but is not a charge — a separate capture is required', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const reserved = unwrap(
      reserve(book, {
        reservationId: 'rsv-1',
        walletId: IDS.ucWallet,
        billingAccountId: IDS.consoleAccount,
        amount: uc(400n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    // Reservation không tạo charge record và không tăng charged balance.
    expect(reserved.book.charges).toHaveLength(0);
    const wallet = unwrap(locateWallet(reserved.book, IDS.ucWallet as never)).wallet;
    expect(wallet.balances.charged.minor).toBe(0n);
    expect(wallet.balances.held.minor).toBe(400n);
  });

  it('a seller payable carries no beneficiary, no fiat amount and no payout execution', () => {
    const { book } = createTestBook();
    const payable = unwrap(
      accruePayable(book, {
        payableId: 'pay-1',
        sellerTenant: 'tenant-seller',
        amount: ec(500n),
        period: '2026-10',
        availableAt: day(20),
        accruedAt: NOW,
        settlementId: 'stl-1',
        chargeId: 'chg-1',
        fencingToken: IDS.ecFence,
      }),
    ).payable;
    expect(Object.hasOwn(payable, 'beneficiary')).toBe(false);
    expect(Object.hasOwn(payable, 'bank_account')).toBe(false);
    expect(Object.hasOwn(payable, 'fiat_amount')).toBe(false);
    // paid_at chỉ được đặt khi caller cấp payout evidence từ ngoài.
    expect(payable.paid_at).toBeNull();
    expect(payable.payout_evidence_ref).toBeNull();
  });

  it('a budget lease grants money, never quota tokens or request limits', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const opened = unwrap(
      openEscrow(book, {
        escrowId: 'esc-1',
        walletId: IDS.ucWallet,
        amount: uc(400n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    const lease = unwrap(
      issueLease(opened.book, {
        leaseId: 'lease-1',
        escrowId: 'esc-1',
        amount: uc(100n),
        epoch: 1,
        fencingToken: 'fence-lease-1',
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
      }),
    ).lease;
    expect(Object.hasOwn(lease, 'quota')).toBe(false);
    expect(Object.hasOwn(lease, 'request_limit')).toBe(false);
    expect(Object.hasOwn(lease, 'token_limit')).toBe(false);
    expect(lease.amount.denomination).toBe('UC');
  });

  it('unused escrow is held money, not an outstanding liability', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const opened = unwrap(
      openEscrow(book, {
        escrowId: 'esc-1',
        walletId: IDS.ucWallet,
        amount: uc(400n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    const wallet = unwrap(locateWallet(opened.book, IDS.ucWallet as never)).wallet;
    expect(wallet.balances.held.minor).toBe(400n);
    // Escrow không sinh payable hay liability record nào.
    expect(opened.book.payables).toHaveLength(0);
    // Tiền vẫn nằm trong wallet — conservation giữ nguyên.
    expect(wallet.balances.total.minor).toBe(1_000n);
  });
});
