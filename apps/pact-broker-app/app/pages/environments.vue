<script setup lang="ts">
/**
 * Environments — danh sách environment + deployment records (issue #208), chỉ
 * đọc qua BFF.
 *
 * ⚠️ **Không có form tạo/sửa environment** ở dashboard: ghi environment thuộc
 * permission matrix ADR-0032 §1 (chỉ admin/owner, qua đường máy CLI) — dashboard
 * M1 chỉ đọc (kết luận #205 quyết định 5).
 *
 * Deployments: BFF (`/api/broker/deployments`) compose từ `/pacticipants` +
 * `/versions` + `/deployed` của API — mỗi row là một deployment đang hiệu lực
 * (hoặc đã undeploy, kèm `undeployedAt`) của version mới nhất.
 */
import { computed } from 'vue';

import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';
import { brokerFetch } from '../utils/broker-fetch';

const { t } = useI18n();

interface EnvironmentRow {
  name?: unknown;
  displayName?: unknown;
  createdAt?: unknown;
  production?: unknown;
}

interface DeploymentRow {
  pacticipant?: unknown;
  version?: unknown;
  environment?: unknown;
  deployedAt?: unknown;
  undeployedAt?: unknown;
}

const { state, reload } = useAsyncState(async () => {
  const res = await brokerFetch('/api/broker/environments');
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 503) {
    return { kind: 'unavailable' as const };
  }
  if (!res.ok) {
    throw new Error(`broker api ${String(res.status)}`);
  }
  const embedded = (body as { _embedded?: { environments?: unknown } })['_embedded'];
  const rows = Array.isArray(embedded?.environments)
    ? (embedded.environments as EnvironmentRow[])
    : [];
  return { kind: 'rows' as const, rows };
});

const isUnavailable = (s: typeof state.value): boolean =>
  s.kind === 'ready' && s.value.kind === 'unavailable';

const rows = computed(() =>
  state.value.kind === 'ready' && state.value.value.kind === 'rows' ? state.value.value.rows : [],
);

/** Deployments — lỗi riêng, không chặn bảng environment. */
const { state: deploymentsState } = useAsyncState(async () => {
  const res = await brokerFetch('/api/broker/deployments');
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 503 || !res.ok) {
    // Deployment là dữ liệu phụ: unavailable/error của nó không phá bảng
    // environment — hiển thị trạng thái riêng của section.
    return { kind: 'unavailable' as const };
  }
  const list = Array.isArray((body as { deployments?: unknown }).deployments)
    ? ((body as { deployments: unknown[] }).deployments as DeploymentRow[])
    : [];
  return { kind: 'rows' as const, rows: list };
});

const deployments = computed(() =>
  deploymentsState.value.kind === 'ready' && deploymentsState.value.value.kind === 'rows'
    ? deploymentsState.value.value.rows
    : [],
);

const textOf = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '—';
</script>

<template>
  <section>
    <PactBrokerPageHeader
      :title="t('environments.title')"
      :description="t('environments.description')"
    />

    <PactBrokerLoadingState v-if="state.kind === 'loading'" :label="t('states.loading')" />

    <PactBrokerErrorState
      v-else-if="state.kind === 'error'"
      :title="t('states.errorTitle')"
      :body="t('states.errorBody')"
      :detail="state.message"
      :retry-label="t('states.retry')"
      :on-retry="reload"
    />

    <PactBrokerUnavailableState
      v-else-if="isUnavailable(state)"
      :title="t('states.unavailableTitle')"
      :body="t('states.unavailableBody')"
    />

    <PactBrokerEmptyState v-else-if="rows.length === 0" :message="t('environments.description')" />

    <div
      v-else
      class="overflow-x-auto rounded-lg border border-border"
      data-testid="pact-broker-environments-table"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
            <th class="px-4 py-2 font-medium">{{ t('environments.name') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('environments.displayName') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('environments.production') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('environments.createdAt') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in rows"
            :key="index"
            class="border-b border-border last:border-0"
          >
            <td class="px-4 py-2 font-mono text-xs">{{ textOf(row.name) }}</td>
            <td class="px-4 py-2 font-medium">{{ textOf(row.displayName) }}</td>
            <td class="px-4 py-2">
              <span v-if="row.production === true" class="text-amber-600 dark:text-amber-400">{{
                t('environments.productionTrue')
              }}</span>
              <span v-else class="text-muted-foreground">{{
                t('environments.productionFalse')
              }}</span>
            </td>
            <td class="px-4 py-2 text-muted-foreground">{{ textOf(row.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="rows.length > 0" class="mt-8">
      <h2 class="mb-3 text-lg font-semibold">{{ t('environments.deploymentsTitle') }}</h2>

      <PactBrokerLoadingState
        v-if="deploymentsState.kind === 'loading'"
        :label="t('states.loading')"
      />
      <p
        v-else-if="
          deploymentsState.kind === 'ready' && deploymentsState.value.kind === 'unavailable'
        "
        class="text-sm text-muted-foreground"
        data-testid="pact-broker-deployments-unavailable"
      >
        {{ t('environments.deploymentsUnavailable') }}
      </p>
      <PactBrokerEmptyState
        v-else-if="deployments.length === 0"
        :message="t('environments.deploymentsEmpty')"
      />
      <div
        v-else
        class="overflow-x-auto rounded-lg border border-border"
        data-testid="pact-broker-deployments-table"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th class="px-4 py-2 font-medium">{{ t('environments.deployedPacticipant') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('environments.deployedVersion') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('environments.deployedEnvironment') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('environments.deployedAt') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('environments.undeployedAt') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in deployments"
              :key="index"
              class="border-b border-border last:border-0"
            >
              <td class="px-4 py-2 font-medium">{{ textOf(row.pacticipant) }}</td>
              <td class="px-4 py-2 font-mono text-xs">{{ textOf(row.version) }}</td>
              <td class="px-4 py-2 font-mono text-xs">{{ textOf(row.environment) }}</td>
              <td class="px-4 py-2 text-muted-foreground">{{ textOf(row.deployedAt) }}</td>
              <td class="px-4 py-2 text-muted-foreground">
                {{
                  row.undeployedAt === null || row.undeployedAt === undefined
                    ? '—'
                    : textOf(row.undeployedAt)
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
