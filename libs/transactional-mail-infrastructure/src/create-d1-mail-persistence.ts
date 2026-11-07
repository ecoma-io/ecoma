import type {
  InternalNonceStore,
  MailMessageRepository,
  MailOutboxRepository,
  MailRateLimitStore,
  MailRetentionQueries,
  MailTemplateRepository,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';
import { D1InternalNonceStore } from './d1-internal-nonce-store';
import { D1MailMessageRepository } from './d1-mail-message-repository';
import { D1MailOutboxRepository } from './d1-mail-outbox-repository';
import { D1MailRateLimitStore } from './d1-mail-rate-limit-store';
import { D1MailRetentionQueries } from './d1-mail-retention-queries';
import { D1MailTemplateRepository } from './d1-mail-template-repository';

/**
 * Bộ persistence của control plane trên một D1 `mail`.
 *
 * Đây là entrypoint duy nhất mà **composition root** của C2 trở đi cần: truyền `env.mail` vào
 * `createD1MailPersistence` là có đủ seam để dựng service.
 *
 * Ranh giới: code **ports/domain** của `type:application` chỉ import
 * `@ecoma-io/transactional-mail-application`, không import lib này — kiểm bằng tagged graph +
 * `pnpm dx arch-check`. Người duy nhất được import factory này là composition root (lắp ghép ở
 * `main.ts` của C2), đúng chỗ duy nhất mà một application được biết tới implementation của nó.
 * C1 chưa lắp ghép gì: `apps/transactional-mail/src/main.ts` không đổi.
 */
export interface D1MailPersistence {
  readonly templates: MailTemplateRepository;
  readonly messages: MailMessageRepository;
  readonly outbox: MailOutboxRepository;
  readonly nonces: InternalNonceStore;
  readonly rateLimits: MailRateLimitStore;
  readonly retention: MailRetentionQueries;
}

/**
 * Dựng toàn bộ persistence trên một D1.
 *
 * Không có state nào nằm ngoài `db`: mỗi instance chỉ là sáu object giữ tham chiếu tới cùng một
 * connection, nên tạo lại instance (mỗi request, mỗi isolate) không mất trạng thái nào — đúng
 * bất biến "không có node-local application state" (`01-architecture.md` §8). Mọi trạng thái
 * bền nằm trong D1.
 *
 * Không có network call, không có credential, không có binding nào khác ngoài `db`: chỉ một
 * database và các port quanh nó.
 */
export function createD1MailPersistence(db: D1SubsetDatabase): D1MailPersistence {
  return {
    templates: new D1MailTemplateRepository(db),
    messages: new D1MailMessageRepository(db),
    outbox: new D1MailOutboxRepository(db),
    nonces: new D1InternalNonceStore(db),
    rateLimits: new D1MailRateLimitStore(db),
    retention: new D1MailRetentionQueries(db),
  };
}
