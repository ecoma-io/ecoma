<script setup lang="ts">
/**
 * Permissions — prototype-only catalog.
 *
 * `Permission.id` là `<domain>.<action>`, theo đúng định nghĩa của
 * `01-architecture.md` §4.3: "một định danh một hành động trên một resource
 * domain". Cả ba trường đều là **giá trị domain**, không dịch — dịch
 * `delivery.redrive` thành một câu tiếng Việt biến một định danh mà backend
 * enforce thành một nhãn không backend nào khớp được.
 *
 * ⚠️ **Không** có permission wildcard (`*`), không có `admin.all`, không có
 * `isAdmin`. §4.4 cấm unrestricted bypass role, và một permission bao trùm
 * trong catalog là đường tắt đúng thứ đó.
 *
 * Fixture này là **illustrative**, không phải catalog authoritative
 * (`prototype-fixture.ts` giải thích đầy đủ).
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';

import { Input } from '@ecoma-io/ui-app-shell';

import { useAsyncState } from '../composables/use-async-state';
import { useBackofficeAdapter } from '../composables/use-backoffice-adapter';

const i18n = useI18n();
const adapter = useBackofficeAdapter();

const { state, reload } = useAsyncState(
  () => adapter.listPermissions(),
  () => false,
);
const search = ref('');

const filtered = computed(() => {
  if (state.value.kind !== 'ready') {
    return [];
  }

  const term = search.value.trim().toLowerCase();
  return state.value.value.filter((permission) => {
    if (term === '') {
      return true;
    }
    return (
      permission.id.toLowerCase().includes(term) ||
      permission.domain.toLowerCase().includes(term) ||
      permission.action.toLowerCase().includes(term)
    );
  });
});
</script>

<template>
  <section>
    <BackofficePageHeader
      :title="i18n.t('pages.permissions.title')"
      :description="i18n.t('pages.permissions.description')"
    />

    <BackofficeSampleNotice :message="i18n.t('prototype.notice.body')" />

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
      <div class="mb-4">
        <label class="text-sm font-medium" for="permissions-search">
          {{ i18n.t('permissions.search.label') }}
        </label>
        <Input
          id="permissions-search"
          v-model="search"
          class="mt-1"
          type="search"
          data-testid="permissions-search-input"
          :placeholder="i18n.t('permissions.search.placeholder')"
        />
      </div>

      <p
        v-if="state.value.length === 0"
        class="text-sm text-muted-foreground"
        data-testid="permissions-empty"
      >
        {{ i18n.t('permissions.empty') }}
      </p>

      <template v-else>
        <p
          v-if="filtered.length === 0"
          class="text-sm text-muted-foreground"
          data-testid="permissions-no-results"
        >
          {{ i18n.t('permissions.noResults') }}
        </p>

        <div v-else class="overflow-x-auto rounded-lg border border-border bg-card">
          <table class="w-full text-sm" data-testid="permissions-table">
            <thead class="bg-muted/50">
              <tr>
                <th class="text-left font-medium p-3">
                  {{ i18n.t('permissions.column.permission') }}
                </th>
                <th class="text-left font-medium p-3">{{ i18n.t('permissions.column.domain') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('permissions.column.action') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="permission in filtered"
                :key="permission.id"
                class="border-t border-border"
              >
                <td class="p-3">
                  <div class="font-mono text-xs">{{ permission.id }}</div>
                  <div class="mt-1 text-xs text-muted-foreground">
                    {{ i18n.t(`permissions.items.${permission.domain}.${permission.action}`) }}
                  </div>
                </td>
                <td class="p-3">{{ permission.domain }}</td>
                <td class="p-3">{{ permission.action }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
