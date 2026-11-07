/**
 * Ghim billing account, wallet, bất biến 5 (conservation) và fencing token.
 */

import { describe, expect, it } from 'vitest';

import { addBillingAccount, checkWalletInvariant, locateWallet, openFinancialBook } from './index';
import {
  attachWallet,
  createBillingAccount,
  createWallet,
  createWalletBalances,
  findWallet,
  findWalletByDenomination,
  isBillingAccount,
  isWallet,
  isWalletBalances,
  replaceWallet,
} from './wallet';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

describe('createWalletBalances', () => {
  it('derives total from the three balances instead of accepting it', () => {
    const balances = unwrap(
      createWalletBalances({ available: uc(10), held: uc(20), charged: uc(30) }),
    );
    expect(balances.total.minor).toBe(60n);
    expect(isWalletBalances(balances)).toBe(true);
  });

  it('accepts an all-zero wallet', () => {
    const balances = unwrap(
      createWalletBalances({ available: uc(0), held: uc(0), charged: uc(0) }),
    );
    expect(balances.total.minor).toBe(0n);
  });

  it('rejects a negative balance — no overdraft in this domain', () => {
    const negative = { denomination: 'UC' as const, minor: -1n };
    expect(
      failureCode(createWalletBalances({ available: negative, held: uc(0), charged: uc(0) })),
    ).toBe('invalid_wallet');
  });

  it('rejects mixed denominations', () => {
    expect(
      failureCode(
        createWalletBalances({
          available: uc(1),
          held: { denomination: 'EC', minor: 0n },
          charged: uc(0),
        }),
      ),
    ).toBe('denomination_mismatch');
  });

  it('rejects a total that would overflow the magnitude', () => {
    const huge = { denomination: 'UC' as const, minor: 10n ** 30n - 1n };
    expect(
      failureCode(createWalletBalances({ available: huge, held: uc(1), charged: uc(0) })),
    ).toBe('amount_overflow');
  });
});

describe('isWalletBalances', () => {
  it('rejects a total that does not equal available plus held plus charged', () => {
    expect(isWalletBalances({ available: uc(1), held: uc(1), charged: uc(1), total: uc(4) })).toBe(
      false,
    );
  });
});

describe('createWallet and account structure', () => {
  it('starts a wallet at zero in one denomination domain', () => {
    const wallet = unwrap(
      createWallet({
        walletId: 'w-1',
        billingAccountId: 'a-1',
        denomination: 'EC',
        fencingToken: 'f-1',
      }),
    );
    expect(wallet.balances.total.minor).toBe(0n);
    expect(wallet.denomination).toBe('EC');
    expect(isWallet(wallet)).toBe(true);
  });

  it('rejects an unknown denomination', () => {
    expect(
      failureCode(
        createWallet({
          walletId: 'w-1',
          billingAccountId: 'a-1',
          denomination: 'USD' as never,
          fencingToken: 'f-1',
        }),
      ),
    ).toBe('invalid_denomination');
  });

  it('rejects a second wallet of the same denomination in one account', () => {
    const account = unwrap(
      createBillingAccount({ billingAccountId: 'a-1', ownerRef: 'o-1', createdAt: NOW }),
    );
    const first = unwrap(
      createWallet({
        walletId: 'w-1',
        billingAccountId: 'a-1',
        denomination: 'UC',
        fencingToken: 'f-1',
      }),
    );
    const second = unwrap(
      createWallet({
        walletId: 'w-2',
        billingAccountId: 'a-1',
        denomination: 'UC',
        fencingToken: 'f-2',
      }),
    );
    const withOne = unwrap(attachWallet(account, first));
    expect(failureCode(attachWallet(withOne, second))).toBe('invalid_wallet');
  });

  it('rejects an account whose wallet belongs to another account', () => {
    const wallet = unwrap(
      createWallet({
        walletId: 'w-1',
        billingAccountId: 'a-2',
        denomination: 'UC',
        fencingToken: 'f-1',
      }),
    );
    expect(
      isBillingAccount({
        ...unwrap(
          createBillingAccount({
            billingAccountId: 'a-1',
            ownerRef: 'o-1',
            createdAt: NOW,
          }),
        ),
        wallets: [wallet],
      }),
    ).toBe(false);
  });
});

describe('wallet lookup and replacement', () => {
  it('finds a wallet by id and by denomination', () => {
    const { book } = createTestBook();
    const located = unwrap(locateWallet(book, IDS.ecWallet as never));
    expect(located.wallet.denomination).toBe('EC');
    expect(unwrap(findWalletByDenomination(located.account, 'EC')).wallet_id).toBe(IDS.ecWallet);
  });

  it('reports a missing wallet instead of returning undefined', () => {
    const { book } = createTestBook();
    expect(failureCode(locateWallet(book, 'missing' as never))).toBe('wallet_not_found');
    expect(
      failureCode(
        findWallet(unwrap(locateWallet(book, IDS.ecWallet as never)).account, 'missing' as never),
      ),
    ).toBe('wallet_not_found');
  });

  it('rejects replacing a wallet that the account does not contain', () => {
    const { book } = createTestBook();
    const account = unwrap(locateWallet(book, IDS.ecWallet as never)).account;
    const other = unwrap(
      createWallet({
        walletId: 'w-other',
        billingAccountId: IDS.sellerAccount,
        denomination: 'UC',
        fencingToken: 'f',
      }),
    );
    expect(failureCode(replaceWallet(account, other))).toBe('wallet_not_found');
  });

  it('rejects a duplicate billing account id', () => {
    const { book } = createTestBook();
    const account = unwrap(locateWallet(book, IDS.ecWallet as never)).account;
    expect(failureCode(addBillingAccount(book, account))).toBe('invalid_wallet');
    expect(unwrap(addBillingAccount(openFinancialBook(), account)).accounts).toHaveLength(1);
  });
});

describe('wallet invariant', () => {
  it('holds available plus held plus charged equal to total after deposits', () => {
    const { book } = createTestBook({ ecAmount: 1_000n, ucAmount: 250n });
    const ecWallet = unwrap(locateWallet(book, IDS.ecWallet as never)).wallet;
    expect(ecWallet.balances.available.minor).toBe(1_000n);
    expect(ecWallet.balances.total.minor).toBe(1_000n);
    expect(checkWalletInvariant(ecWallet)).toBeNull();
  });
});
