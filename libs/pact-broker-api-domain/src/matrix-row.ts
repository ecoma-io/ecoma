/**
 * Decorate một matrix row (dữ liệu thô từ repo layer) với HAL links, cho ra
 * hình dạng wire theo matrix_decorator.rb của reference broker.
 *
 * Port từ upstream `src/services/matrix-row.ts` (REUSE) — chỉ đổi import type.
 * Link thêm ở đây chứ không ở repo layer vì chỉ request mới biết host public.
 */
import type { MatrixRow, MatrixVersion, MatrixVersionData } from './types';
import type { HalBuilder } from './hal';

function decorateVersion(
  hal: HalBuilder,
  pacticipant: string,
  version: MatrixVersionData,
): MatrixVersion {
  return {
    number: version.number,
    branch: version.branch,
    tags: version.tags.map((name) => ({ name })),
    _links: {
      self: hal.link(
        `/pacticipants/${encodeURIComponent(pacticipant)}/versions/${encodeURIComponent(version.number)}`,
      ),
    },
  };
}

export function decorateMatrixRow(
  hal: HalBuilder,
  row: import('./types').MatrixRowData,
): MatrixRow {
  return {
    consumer: {
      name: row.consumer.name,
      version: decorateVersion(hal, row.consumer.name, row.consumer.version),
      _links: { self: hal.link(`/pacticipants/${encodeURIComponent(row.consumer.name)}`) },
    },
    provider: {
      name: row.provider.name,
      version: row.provider.version
        ? decorateVersion(hal, row.provider.name, row.provider.version)
        : null,
      _links: { self: hal.link(`/pacticipants/${encodeURIComponent(row.provider.name)}`) },
    },
    pact: {
      createdAt: row.pact.createdAt,
      _links: {
        self: hal.pact(
          row.provider.name,
          row.consumer.name,
          row.consumer.version.number,
          row.pact.sha,
        ).self,
      },
    },
    verificationResult: row.verification
      ? {
          success: row.verification.success,
          verifiedAt: row.verification.verifiedAt,
          _links: {
            self: hal.verification(
              row.provider.name,
              row.consumer.name,
              row.pact.sha,
              row.verification.id,
            ).self,
          },
        }
      : null,
  };
}
