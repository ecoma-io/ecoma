<script setup lang="ts">
/**
 * Environments — danh sách environment của tenant, chỉ đọc qua BFF.
 *
 * ⚠️ **Không có form tạo/sửa environment** ở dashboard phiên này: thao tác ghi
 * cần quyền per-user thật (SR-004); với machine token tĩnh của deploy unit, mọi
 * nút ghi là ghi bằng quyền của token chứ không phải của người dùng. API giữ
 * đường CRUD qua machine token (Pact CLI/pact-broker-client) — đó là đường ghi
 * có chủ đích.
 */
import { computed } from 'vue';

import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';

const { t } = useI18n();

interface EnvironmentRow {
  name?: unknown;
  displayName?: unknown;
  createdAt?: unknown;
}

const { state, reload } = useAsyncState(async () => {
  const res = await fetch('/api/broker/environments');
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
            <td class="px-4 py-2 text-muted-foreground">{{ textOf(row.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
