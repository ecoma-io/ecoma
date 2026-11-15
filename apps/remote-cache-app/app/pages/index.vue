<script setup lang="ts">
/**
 * Projects — danh sách project cache của tenant, đọc qua BFF
 * (`GET /api/portal/tenants/:tenantName/projects`, R19).
 *
 * ⚠️ Tenant name: trang lấy từ runtime config public
 * (`public.remoteCacheTenantName`) — tên tenant canonical mà deploy layer ghim
 * (ADR-0020 Quyết định 9: `ecoma` mọi environment). Trang **không** đoán tenant
 * từ token: giá trị vắng ⇒ trạng thái unavailable fail-closed, không gọi BFF.
 *
 * Giữ đúng **một** `<h1>` localized (khối `RemoteCacheAppPageHeader`).
 */
import { computed } from 'vue';
import { useI18n } from '#i18n';
import { Button } from '@ecoma-io/ui-app-shell';

import { useAsyncState } from '../composables/use-async-state';
import { isUnavailableState } from '../composables/unavailable-state';
import { portalFetch } from '../utils/portal-fetch';

const { t } = useI18n();

interface ProjectWire {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

/** Giá trị `ready` đánh dấu trạng thái unavailable (503 / thiếu tenant) — không phải dữ liệu. */
const UNAVAILABLE = Symbol('unavailable');

interface ProjectsPage {
  readonly projects: readonly ProjectWire[];
  readonly next_cursor: string | null;
}

const runtimeConfig = useRuntimeConfig();
// Tenant name là định danh công khai (không secret); vắng ⇒ fail-closed dưới.
const tenantName = computed(() =>
  typeof runtimeConfig.public?.remoteCacheTenantName === 'string'
    ? runtimeConfig.public.remoteCacheTenantName
    : '',
);

const { state, reload } = useAsyncState(async (): Promise<ProjectsPage | typeof UNAVAILABLE> => {
  if (tenantName.value.length === 0) {
    return UNAVAILABLE;
  }
  const res = await portalFetch(`/api/portal/tenants/${tenantName.value}/projects`);
  if (res.status === 503) {
    // BFF chưa cấu hình control plane — trạng thái unavailable, không phải lỗi.
    return UNAVAILABLE;
  }
  if (!res.ok) {
    throw new Error(`portal api ${String(res.status)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { projects?: unknown }).projects)
  ) {
    throw new Error('unexpected projects response shape');
  }
  return body as ProjectsPage;
});

const isUnavailable = computed(() => isUnavailableState(state.value, UNAVAILABLE));

const projects = computed(() =>
  state.value.kind === 'ready' && Array.isArray((state.value.value as ProjectsPage).projects)
    ? (state.value.value as ProjectsPage).projects
    : [],
);

const createdAtOf = (project: ProjectWire): string => {
  // `new Date(null)` trả epoch — guard trước để giá trị thiếu hiển thị '—'.
  if (project.created_at === null || project.created_at === undefined) return '—';
  const date = new Date(project.created_at);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
};
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <RemoteCacheAppPageHeader :title="t('projects.title')" :description="t('projects.description')">
      <template #actions>
        <Button as-child data-testid="remote-cache-app-create-project-link">
          <NuxtLink to="/projects/new">{{ t('projects.createProject') }}</NuxtLink>
        </Button>
      </template>
    </RemoteCacheAppPageHeader>

    <RemoteCacheAppLoadingState v-if="state.kind === 'loading'" :label="t('states.loading')" />

    <RemoteCacheAppErrorState
      v-else-if="state.kind === 'error'"
      :title="t('states.errorTitle')"
      :body="t('states.errorBody')"
      :detail="state.message"
      :retry-label="t('states.retry')"
      :on-retry="reload"
    />

    <RemoteCacheAppUnavailableState
      v-else-if="isUnavailable"
      :title="t('states.unavailableTitle')"
      :body="t('states.unavailableBody')"
    />

    <RemoteCacheAppEmptyState
      v-else-if="projects.length === 0"
      :message="t('projects.emptyMessage')"
    />

    <div
      v-else
      class="overflow-x-auto rounded-lg border border-border"
      data-testid="remote-cache-app-projects-table"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
            <th class="px-4 py-2 font-medium">{{ t('projects.nameHeader') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('projects.createdAtHeader') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="project in projects"
            :key="project.id"
            class="border-b border-border last:border-0"
          >
            <td class="px-4 py-2 font-medium">
              <NuxtLink
                :to="`/projects/${project.name}`"
                class="underline-offset-4 hover:underline"
                >{{ project.name }}</NuxtLink
              >
            </td>
            <td class="px-4 py-2 font-mono text-xs">{{ createdAtOf(project) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
