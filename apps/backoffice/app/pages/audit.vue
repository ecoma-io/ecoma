<script setup lang="ts">
/**
 * Audit trail — hiển thị bản ghi authorization audit của Staff Access qua
 * `GET /api/audit/entries` (P5.4, issue #478).
 *
 * Chỉ đọc: không nút xóa, không sửa bản ghi — audit là append-only, access-restricted
 * (SR-015). Tất cả bản ghi đã có `outcome` (`success` / `failure` / `denied`),
 * nên trang không cần phân loại thêm theo verdict, chỉ hiện kết quả đã ghi server-side.
 *
 * Query filter: actor, target, action, time range, correlation_id. Mọi bộ lọc đều
 * chuyển thẳng qua query string của `GET /api/audit/entries` — backend Staff Access
 * chịu trách nhiệm validate (hợp đồng `validateAuditQueryRequest`).
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';
import { useBackofficeAdapter } from '../composables/use-backoffice-adapter';
import type { AuditEntry } from '../backoffice-data';

const i18n = useI18n();
const adapter = useBackofficeAdapter();

const { state, reload } = useAsyncState(
  () => adapter.listAuditEntries({}),
  () => false,
);

const actorFilter = ref('');
const targetFilter = ref('');
const actionFilter = ref('');
const outcomeFilter = ref<'success' | 'failure' | 'denied' | 'all'>('all');

const filtered = computed(() => {
  if (state.value.kind !== 'ready') {
    return [];
  }

  const actor = actorFilter.value.trim().toLowerCase();
  const target = targetFilter.value.trim().toLowerCase();
  const action = actionFilter.value.trim().toLowerCase();

  return state.value.value.filter((entry) => {
    if (actor !== '' && !entry.actor_staff_id?.toLowerCase().includes(actor)) return false;
    if (target !== '' && !entry.target.toLowerCase().includes(target)) return false;
    if (action !== '' && !entry.action.toLowerCase().includes(action)) return false;
    if (outcomeFilter.value !== 'all' && entry.outcome !== outcomeFilter.value) return false;
    return true;
  });
});

const outcomeLabel = (outcome: AuditEntry['outcome']): string => {
  switch (outcome) {
    case 'success':
      return i18n.t('audit.outcome.success');
    case 'failure':
      return i18n.t('audit.outcome.failure');
    case 'denied':
      return i18n.t('audit.outcome.denied');
  }
  return '';
};
</script>

<template>
  <section>
    <BackofficePageHeader
      :title="i18n.t('audit.title')"
      :description="i18n.t('audit.description')"
    />

    <BackofficeLoadingState v-if="state.kind === 'loading'" :label="i18n.t('states.loading')" />

    <BackofficeErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
      :retry-label="i18n.t('states.retry')"
      :on-retry="reload"
    />

    <template v-else-if="state.kind === 'ready'">
      <div class="mb-4 grid gap-3 md:grid-cols-3">
        <div>
          <label class="text-sm font-medium" for="audit-actor">
            {{ i18n.t('audit.column.actor') }}
          </label>
          <input
            id="audit-actor"
            v-model="actorFilter"
            class="border-input mt-1 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            type="search"
          />
        </div>
        <div>
          <label class="text-sm font-medium" for="audit-target">
            {{ i18n.t('audit.column.target') }}
          </label>
          <input
            id="audit-target"
            v-model="targetFilter"
            class="border-input mt-1 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            type="search"
          />
        </div>
        <div>
          <label class="text-sm font-medium" for="audit-action">
            {{ i18n.t('audit.column.action') }}
          </label>
          <input
            id="audit-action"
            v-model="actionFilter"
            class="border-input mt-1 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            type="search"
          />
        </div>
      </div>

      <p
        v-if="state.value.length === 0"
        class="text-sm text-muted-foreground"
        data-testid="audit-empty"
      >
        {{ i18n.t('audit.empty') }}
      </p>

      <template v-else>
        <p
          v-if="filtered.length === 0"
          class="text-sm text-muted-foreground"
          data-testid="audit-no-results"
        >
          {{ i18n.t('audit.noResults') }}
        </p>

        <div v-else class="overflow-x-auto rounded-lg border border-border bg-card">
          <table class="w-full text-sm" data-testid="audit-table">
            <thead class="bg-muted/50">
              <tr>
                <th class="text-left font-medium p-3">{{ i18n.t('audit.column.time') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('audit.column.actor') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('audit.column.target') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('audit.column.action') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('audit.column.outcome') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('audit.column.reason') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in filtered" :key="entry.id" class="border-t border-border">
                <td class="p-3 font-mono text-xs text-muted-foreground">{{ entry.occurred_at }}</td>
                <td class="p-3">{{ entry.actor_staff_id ?? '-' }}</td>
                <td class="p-3 font-mono text-xs">{{ entry.target }}</td>
                <td class="p-3 font-mono text-xs">{{ entry.action }}</td>
                <td class="p-3">{{ outcomeLabel(entry.outcome) }}</td>
                <td class="p-3 text-muted-foreground">{{ entry.reason ?? '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
