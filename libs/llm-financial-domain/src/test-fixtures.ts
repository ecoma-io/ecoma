/**
 * Fixture dùng chung cho spec của `llm-financial-domain`.
 *
 * Chỉ phục vụ test: dựng một book có hai billing account (seller EC và console
 * UC), nạp tiền qua đúng đường `registerDeposit` + `creditDeposit`, và expose
 * helper `unwrap`/`failureCode` để test đọc kết quả `FinancialResult`.
 *
 * Không export từ `index.ts` — đây không phải public surface.
 */

import { addBillingAccount, creditDeposit, openFinancialBook, registerDeposit } from './index';
import type { FinancialBook } from './book';
import { createMoney, type Denomination, type Money } from './money';
import { createBillingAccount, createWallet, attachWallet, type BillingAccount } from './wallet';
import type { FinancialResult } from './shared';

/** Mốc thời gian gốc — mọi timestamp trong test suy ra từ đây, không đọc đồng hồ. */
export const NOW = 1_700_000_000_000;

/** Ngày (millis) — helper cho test đọc dễ hơn. */
export function day(offset: number): number {
  return NOW + offset * 86_400_000;
}

/** Dựng một số tiền; ném khi fixture sai để lỗi test chỉ đúng chỗ. */
export function money<D extends Denomination>(denomination: D, minor: bigint | number): Money<D> {
  const created = createMoney(denomination, minor);
  if (!created.ok) {
    throw new Error(`Fixture amount is invalid: ${denomination} ${String(minor)}`);
  }
  return created.value;
}

/** UC amount. */
export function uc(minor: bigint | number): Money<'UC'> {
  return money('UC', minor);
}

/** EC amount. */
export function ec(minor: bigint | number): Money<'EC'> {
  return money('EC', minor);
}

/** Lấy value của một result thành công; ném khi là failure. */
export function unwrap<Value>(result: FinancialResult<Value>): Value {
  if (!result.ok) {
    throw new Error(`Expected an ok result, received domain error: ${result.error.code}`);
  }
  return result.value;
}

/** Lấy error code của một result thất bại; ném khi là success. */
export function failureCode(result: FinancialResult<unknown>): string {
  if (result.ok) {
    throw new Error('Expected a domain failure, received an ok result.');
  }
  return result.error.code;
}

/** Định danh cố định của fixture book. */
export const IDS = Object.freeze({
  sellerAccount: 'acct-seller',
  consoleAccount: 'acct-console',
  sellerOwner: 'owner-seller',
  consoleOwner: 'owner-console',
  ecWallet: 'wallet-ec',
  ucWallet: 'wallet-uc',
  ecFence: 'fence-ec-1',
  ucFence: 'fence-uc-1',
});

/** Fixture book đã có hai account, hai wallet và tiền nạp ban đầu. */
export interface TestBook {
  readonly book: FinancialBook;
}

/** Dựng fixture book với EC và UC đã nạp tiền. */
export function createTestBook(options?: {
  readonly ecAmount?: bigint;
  readonly ucAmount?: bigint;
}): TestBook {
  const ecAmount = options?.ecAmount ?? 10_000n;
  const ucAmount = options?.ucAmount ?? 5_000n;

  const sellerAccount: BillingAccount = Object.freeze({
    ...unwrap(
      createBillingAccount({
        billingAccountId: IDS.sellerAccount,
        ownerRef: IDS.sellerOwner,
        createdAt: NOW,
      }),
    ),
    wallets: Object.freeze([
      unwrap(
        createWallet({
          walletId: IDS.ecWallet,
          billingAccountId: IDS.sellerAccount,
          denomination: 'EC',
          fencingToken: IDS.ecFence,
        }),
      ),
    ]),
  });
  const consoleAccount: BillingAccount = Object.freeze({
    ...unwrap(
      createBillingAccount({
        billingAccountId: IDS.consoleAccount,
        ownerRef: IDS.consoleOwner,
        createdAt: NOW,
      }),
    ),
    wallets: Object.freeze([
      unwrap(
        createWallet({
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          denomination: 'UC',
          fencingToken: IDS.ucFence,
        }),
      ),
    ]),
  });

  let book = unwrap(addBillingAccount(openFinancialBook(), sellerAccount));
  book = unwrap(addBillingAccount(book, consoleAccount));

  book = fund(
    book,
    { depositId: 'dep-ec', walletId: IDS.ecWallet, fencingToken: IDS.ecFence },
    ec(ecAmount),
  );
  book = fund(
    book,
    { depositId: 'dep-uc', walletId: IDS.ucWallet, fencingToken: IDS.ucFence },
    uc(ucAmount),
  );
  return { book };
}

/** Nạp tiền qua đúng đường deposit: pending → credited. Bỏ qua amount 0. */
function fund(
  book: FinancialBook,
  target: { depositId: string; walletId: string; fencingToken: string },
  amount: Money,
): FinancialBook {
  if (amount.minor === 0n) {
    return book;
  }
  const registered = unwrap(
    registerDeposit(book, {
      depositId: target.depositId,
      walletId: target.walletId,
      amount,
      paymentReference: `payment:${target.depositId}`,
      createdAt: NOW,
    }),
  );
  const credited = unwrap(
    creditDeposit(registered.book, {
      depositId: target.depositId,
      creditedAt: NOW,
      fencingToken: target.fencingToken,
    }),
  );
  return credited.book;
}

/** Account đã attach thêm wallet — chỉ dùng khi test cần account chưa có ví. */
export function withWallet(
  account: BillingAccount,
  wallet: ReturnType<typeof createWallet>,
): BillingAccount {
  return unwrap(attachWallet(account, unwrap(wallet)));
}
