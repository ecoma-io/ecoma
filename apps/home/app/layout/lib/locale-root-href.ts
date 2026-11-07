/**
 * href về bề mặt root của locale trong một layout đã parse.
 *
 * Dùng chung cho brand link của `PublicHeader`/`PublicFooter` để hai bề
 * mặt luôn lockstep: cùng một state đã parse → cùng một URL, không mỗi
 * component tự dựng công thức riêng.
 *
 * Luôn trả về một href hợp lệ, không throw: `root`/`invalid` (chưa có
 * locale) → `/`; dựng qua `buildPublicPath` nên không có string-concat.
 */
import type { PublicLocale } from '../../i18n/index';
import { buildPublicPath } from './build-public-path';
import type { PublicLayoutPathResult } from './public-layout-path';

export function localeRootHref(layout: PublicLayoutPathResult): string {
  if (layout.kind !== 'localized' && layout.kind !== 'locale-root') {
    return '/';
  }
  const locale: PublicLocale = layout.locale;
  const built = buildPublicPath({ locale });
  return built.kind === 'invalid' ? '/' : built.path;
}
