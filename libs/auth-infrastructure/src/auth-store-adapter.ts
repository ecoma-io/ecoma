import type {
  AuthStore,
  NewAuthorizationCode,
  NewAuthorizationTransaction,
} from '@ecoma-io/auth-application';
import type { AuthorizationTransactionState } from '@ecoma-io/auth-domain';

import {
  insertAuthorizationCode as insertAuthorizationCodeRow,
  insertTransaction,
  findTransactionByHandleX,
  transitionTransaction,
} from './authorization-transaction-store';
import { checkRevocationAtIssuance } from './token-revocation-store';
import { findActiveGrant } from './oauth-grant-store';
import { findRegisteredClient } from './oauth-client-store';
import type { PostgresClientLike } from './postgres';

/**
 * Adapter dựng `AuthStore` (interface application layer) từ các hàm store của
 * lib này cho `db-auth`.
 *
 * ## Ranh giới
 *
 * Từng nằm trong `apps/auth/src/authorization-store.ts` — chỗ tạm của app cho
 * tới khi lib sở hữu nó (#343). Vị trí tự nhiên của adapter là infrastructure:
 * một adapter CẦN application (để hiện thực interface của nó), và quy tắc
 * `type:infrastructure` cho phép phụ thuộc `type:application` — chiều ngược
 * lại mới bị cấm (libs/AGENTS.md, 05-code-architecture.md).
 */

/**
 * Tham số dựng store — tường minh thay vì đọc biến toàn cục.
 *
 * `client` là pool của isolate (xem `oidc/provider.ts` về vòng đời runtime).
 */
export interface AuthorizationStoreDeps {
  readonly client: PostgresClientLike;
}

/** Cài đặt `AuthStore` của application layer cho `db-auth`. */
export function createAuthorizationStore(deps: AuthorizationStoreDeps): AuthStore {
  const { client } = deps;
  return {
    async findTransactionByHandleX(params) {
      return findTransactionByHandleX(client, params);
    },

    async createTransaction(record: NewAuthorizationTransaction): Promise<void> {
      await insertTransaction(client, record);
    },

    async transition(params: {
      transactionId: string;
      from: AuthorizationTransactionState;
      to: AuthorizationTransactionState;
      at: Date;
    }): Promise<boolean> {
      return transitionTransaction(client, params);
    },

    async insertAuthorizationCode(code: NewAuthorizationCode): Promise<void> {
      await insertAuthorizationCodeRow(client, code);
    },

    async findGrant(params: { accountId: string; clientId: string }) {
      const grant = await findActiveGrant(client, {
        sub: params.accountId,
        clientId: params.clientId,
      });
      // Structural typing: object có thừa `id` vẫn khớp `AuthGrant`.
      return grant;
    },

    async findClient(clientId: string) {
      return findRegisteredClient(client, clientId);
    },

    async checkRevocation(params: { accountId: string; clientId: string }) {
      return checkRevocationAtIssuance(client, {
        sub: params.accountId,
        clientId: params.clientId,
      });
    },
  };
}
