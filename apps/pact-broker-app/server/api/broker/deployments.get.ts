import { defineEventHandler, getQuery, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';
import { requirePrincipal } from '../../principal';

/**
 * `GET /api/broker/deployments` — deployment records của một version, cho
 * trang Environments (issue #208): mỗi environment đang thấy pacticipant
 * version nào.
 *
 * Compose từ endpoint HAL hiện có (quyết định 17 của #205):
 * 1. `GET /pacticipants` — danh sách pacticipant của tenant.
 * 2. Với mỗi pacticipant (giới hạn hiển thị bởi trang, không phải BFF),
 *    `GET /pacticipants/<name>/versions/<version>/deployed` trả deployments.
 *    Version "hiện hành" của dashboard là version mới nhất — lấy từ
 *    `GET /pacticipants/<name>/versions` (mục đầu của danh sách là mới nhất
 *    theo `PgVersionRepo.getVersionsByPacticipant`).
 *
 * Query tuỳ chọn: `pacticipant` — khi có, chỉ pacticipant đó được tra.
 *
 * Shape trả về: `{ deployments: [{ pacticipant, version, environment,
 * deployedAt, undeployedAt }] }` — hợp nhất của mọi version mới nhất.
 */
interface DeploymentRow {
  readonly pacticipant: string;
  readonly version: string;
  readonly environment: unknown;
  readonly deployedAt: unknown;
  readonly undeployedAt: unknown;
}

export default defineEventHandler(async (event) => {
  const principal = requirePrincipal(event);

  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  // Hop 1 — danh sách pacticipant (hoặc lọc theo query khi caller chỉ định).
  const list = await brokerCall(config, principal.accessToken, '/pacticipants');
  if (list.errorCode !== null || list.status !== 200) {
    setResponseStatus(event, list.errorCode !== null ? 502 : list.status);
    return list.body ?? { error: 'broker_unreachable' };
  }
  const embedded = (list.body as Record<string, unknown> | null)?.['_embedded'] as
    | { pacticipants?: unknown }
    | undefined;
  const rows = Array.isArray(embedded?.pacticipants) ? embedded.pacticipants : [];
  const filter = getQuery(event).pacticipant;
  const names = rows
    .map((row) => (row as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .filter((name) => typeof filter !== 'string' || filter === '' || name === filter);

  // Hop 2 — per pacticipant: version mới nhất rồi deployments của nó.
  // Tuần tự để không dồn pool Hyperdrive (cùng lý do seed của broker-stack).
  const deployments: DeploymentRow[] = [];
  for (const name of names) {
    const versions = await brokerCall(
      config,
      principal.accessToken,
      `/pacticipants/${encodeURIComponent(name)}/versions`,
    );
    if (versions.errorCode !== null || versions.status !== 200) {
      continue;
    }
    const versionsBody = versions.body as { _embedded?: { versions?: unknown } } | null;
    const versionRows = Array.isArray(versionsBody?.['_embedded']?.versions)
      ? (versionsBody?.['_embedded']?.versions as Array<{ number?: unknown }>)
      : [];
    const latestNumber = versionRows[0]?.number;
    if (typeof latestNumber !== 'string' || latestNumber === '') {
      continue;
    }
    const deployed = await brokerCall(
      config,
      principal.accessToken,
      `/pacticipants/${encodeURIComponent(name)}/versions/${encodeURIComponent(latestNumber)}/deployed`,
    );
    if (deployed.errorCode !== null || deployed.status !== 200) {
      continue;
    }
    const deployedBody = deployed.body as { _embedded?: { deployments?: unknown } } | null;
    const deployedRows = Array.isArray(deployedBody?.['_embedded']?.deployments)
      ? (deployedBody?.['_embedded']?.deployments as Array<Record<string, unknown>>)
      : [];
    for (const row of deployedRows) {
      deployments.push({
        pacticipant: name,
        version: latestNumber,
        environment: row['environment'],
        deployedAt: row['deployedAt'],
        undeployedAt: row['undeployedAt'],
      });
    }
  }

  setResponseStatus(event, 200);
  return { deployments };
});
