import type {
  MailTemplateRecord,
  MailTemplateRepository,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';
import { MAIL_TEMPLATE_COLUMNS, toMailTemplateRecord } from './rows';
import type { MailTemplateRow } from './rows';

const SELECT_BY_ID = `SELECT ${MAIL_TEMPLATE_COLUMNS} FROM mail_templates WHERE id = ?`;

/**
 * `status = 'active'` là điều kiện chọn duy nhất được `01-architecture.md` §4.1 chốt.
 *
 * `ORDER BY version` chỉ để kết quả ổn định và đọc được — **không** phải quy tắc chọn một
 * version: port trả về mảng, việc chọn là implementation gate của C3 (xem JSDoc của port).
 */
const SELECT_ACTIVE_BY_NAME_LOCALE = `
SELECT ${MAIL_TEMPLATE_COLUMNS}
FROM mail_templates
WHERE name = ? AND locale = ? AND status = 'active'
ORDER BY version ASC
`;

/** Repository D1 của `mail_templates` — chỉ đọc, đúng như port. */
export class D1MailTemplateRepository implements MailTemplateRepository {
  readonly #db: D1SubsetDatabase;

  constructor(db: D1SubsetDatabase) {
    this.#db = db;
  }

  async findById(id: string): Promise<MailTemplateRecord | null> {
    const found = await this.#db.prepare(SELECT_BY_ID).bind(id).all<MailTemplateRow>();
    const row = found.results[0];
    return row ? toMailTemplateRecord(row) : null;
  }

  async findActiveByNameAndLocale(
    name: string,
    locale: string,
  ): Promise<readonly MailTemplateRecord[]> {
    const found = await this.#db
      .prepare(SELECT_ACTIVE_BY_NAME_LOCALE)
      .bind(name, locale)
      .all<MailTemplateRow>();
    return found.results.map(toMailTemplateRecord);
  }
}
