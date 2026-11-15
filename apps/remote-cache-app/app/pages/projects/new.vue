<script setup lang="ts">
/**
 * Create project — form tạo project mới + API key đầu tiên (R19).
 *
 * Luồng: submit qua BFF `POST /api/portal/tenants/:tenantName/projects` —
 * control plane tạo project + key trong MỘT transaction và trả token show-once;
 * trang render hộp thoại {@link RemoteCacheAppShowOnceDialog} với token đó và
 * **thả** response sau khi đóng (SR show-once: không có gì giữ lại token).
 *
 * 409 (trùng tên) là lỗi **nghiệp vụ có nghĩa** — hiển thị inline, không đổ vào
 * khung lỗi toàn trang: người dùng sửa tên rồi submit lại.
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';
import { Button, Input, Label } from '@ecoma-io/ui-app-shell';

import RemoteCacheAppShowOnceDialog from '../../components/RemoteCacheAppShowOnceDialog.vue';
import { portalFetch } from '../../utils/portal-fetch';

const { t } = useI18n();

const runtimeConfig = useRuntimeConfig();
const tenantName = computed(() =>
  typeof runtimeConfig.public?.remoteCacheTenantName === 'string'
    ? runtimeConfig.public.remoteCacheTenantName
    : '',
);

const name = ref('');
const submitting = ref(false);
const loadError = ref<string | null>(null);
// Lỗi nghiệp vụ của lần submit hiện tại (409 trùng tên, 400 tên sai hình...) —
// xoá ở lần submit kế.
const formError = ref<string | null>(null);
const showOnceToken = ref<string | null>(null);

/** Pattern tên project — mirror contract control plane (`portal-contract.ts`). */
const PROJECT_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u;

const nameValid = computed(() => PROJECT_NAME_PATTERN.test(name.value));

async function submit(): Promise<void> {
  // Tenant vắng ⇒ URL sai hình `/tenants//projects` — guard sớm, cùng luật
  // fail-closed với trang danh sách và trang chi tiết.
  if (!nameValid.value || submitting.value || tenantName.value.length === 0) return;
  submitting.value = true;
  formError.value = null;
  loadError.value = null;
  try {
    const res = await portalFetch(`/api/portal/tenants/${tenantName.value}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.value }),
    });
    if (res.status === 201) {
      const body: unknown = await res.json().catch(() => null);
      const token = (body as { api_key?: { token?: unknown } } | null)?.api_key?.token;
      if (typeof token === 'string' && token.length > 0) {
        // Show-once: token đi thẳng vào hộp thoại, không lưu state nào khác.
        showOnceToken.value = token;
      } else {
        loadError.value = 'unexpected create-project response shape';
      }
      return;
    }
    if (res.status === 401) {
      // portalFetch đã điều hướng login; nhánh này chỉ để không rơi qua.
      return;
    }
    const body: unknown = await res.json().catch(() => null);
    const message = (body as { message?: unknown } | null)?.message;
    formError.value =
      typeof message === 'string' && message.length > 0
        ? message
        : `portal api ${String(res.status)}`;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}

function closeShowOnce(): void {
  // Thả token — SR show-once: sau khi đóng, không bên nào còn giữ.
  showOnceToken.value = null;
  // Tên đã dùng xong: xoá để tránh tình trạng người dùng submit lại trúng 409.
  name.value = '';
}
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <RemoteCacheAppPageHeader
      :title="t('projectCreate.title')"
      :description="t('projectCreate.description')"
    />

    <form
      class="max-w-md rounded-lg border border-border bg-card p-4"
      data-testid="remote-cache-app-create-project-form"
      @submit.prevent="submit"
    >
      <Label for="project-name">{{ t('projectCreate.nameLabel') }}</Label>
      <Input
        id="project-name"
        v-model="name"
        class="mt-2"
        type="text"
        autocomplete="off"
        spellcheck="false"
        required
        data-testid="remote-cache-app-create-project-name"
      />
      <p class="mt-1 text-xs text-muted-foreground">{{ t('projectCreate.nameHint') }}</p>

      <p
        v-if="formError"
        class="mt-3 text-sm text-destructive"
        data-testid="remote-cache-app-create-project-error"
      >
        {{ formError }}
      </p>
      <RemoteCacheAppErrorState
        v-if="loadError"
        class="mt-3"
        :title="t('states.errorTitle')"
        :body="t('states.errorBody')"
        :detail="loadError"
      />

      <Button
        class="mt-4"
        type="submit"
        :disabled="!nameValid || submitting"
        data-testid="remote-cache-app-create-project-submit"
      >
        {{ submitting ? t('projectCreate.submitting') : t('projectCreate.submit') }}
      </Button>
    </form>

    <RemoteCacheAppShowOnceDialog
      v-if="showOnceToken !== null"
      :token="showOnceToken"
      :open="true"
      @confirm="closeShowOnce"
    />
  </section>
</template>
