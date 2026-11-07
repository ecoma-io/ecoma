<script setup lang="ts">
/**
 * Roles — prototype-only catalog.
 *
 * ⚠️ Chỉ hiện **system-defined role** có trong fixture. Không custom role, không
 * role hierarchy (`01-architecture.md` §4.7 deferred), không `isAdmin` bypass.
 *
 * `SystemRole.id` là định danh ổn định; nhãn hiển thị lấy từ catalog `roles.items.{id}.name`.
 * Mô tả cũng đi qua catalog. `permissionIds` giữ dạng `domain.action` như fixture.
 * Permission count được tính và hiển thị để dễ quan sát tập permission hữu hạn của
 * từng role (`§4.4`: "mọi role đều là tập permission hữu hạn").
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';

import { Input } from '@ecoma-io/ui-app-shell';

import { useAsyncState } from '../composables/use-async-state';
import { useBackofficeAdapter } from '../composables/use-backoffice-adapter';

const i18n = useI18n();
const adapter = useBackofficeAdapter();

const { state, reload } = useAsyncState(
  () => adapter.listRoles(),
  () => false,
);
const search = ref('');

const filtered = computed(() => {
  if (state.value.kind !== 'ready') {
    return [];
  }

  const term = search.value.trim().toLowerCase();
  return state.value.value.filter((role) => {
    if (term === '') {
      return true;
    }
    const name = i18n.t(`roles.items.${role.id}.name`).toLowerCase();
    return name.includes(term) || role.id.toLowerCase().includes(term);
  });
});
</script>

<template>
  <section>
    <BackofficePageHeader
      :title="i18n.t('pages.roles.title')"
      :description="i18n.t('pages.roles.description')"
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
        <label class="text-sm font-medium" for="roles-search">
          {{ i18n.t('roles.search.label') }}
        </label>
        <Input
          id="roles-search"
          v-model="search"
          class="mt-1"
          type="search"
          data-testid="roles-search-input"
          :placeholder="i18n.t('roles.search.placeholder')"
        />
      </div>

      <p
        v-if="state.value.length === 0"
        class="text-sm text-muted-foreground"
        data-testid="roles-empty"
      >
        {{ i18n.t('roles.empty') }}
      </p>

      <template v-else>
        <p
          v-if="filtered.length === 0"
          class="text-sm text-muted-foreground"
          data-testid="roles-no-results"
        >
          {{ i18n.t('roles.noResults') }}
        </p>

        <div v-else class="overflow-x-auto rounded-lg border border-border bg-card">
          <table class="w-full text-sm" data-testid="roles-table">
            <thead class="bg-muted/50">
              <tr>
                <th class="text-left font-medium p-3">{{ i18n.t('roles.column.role') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('roles.column.permissions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="role in filtered" :key="role.id" class="border-t border-border">
                <td class="p-3">
                  <div class="font-medium">{{ i18n.t(`roles.items.${role.id}.name`) }}</div>
                  <div class="text-xs text-muted-foreground mt-1">
                    {{ i18n.t(`roles.items.${role.id}.description`) }}
                  </div>
                  <div class="text-xs text-muted-foreground mt-1">ID: {{ role.id }}</div>
                </td>
                <td class="p-3 text-muted-foreground">
                  <div>
                    {{ i18n.t('roles.permissionCount', { count: role.permissionIds.length }) }}
                  </div>
                  <div class="text-xs mt-1">{{ role.permissionIds.join(', ') }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
