<script setup lang="ts">
/**
 * Hộp thoại show-once — bề mặt DUY NHẤT mà browser thấy token API key.
 *
 * ⚠️ SR "show-once": token nằm ở đây là **giá trị duy nhất lần này** — component
 * KHÔNG persist token vào state toàn cục, `sessionStorage`, hay bất kỳ kho nào;
 * khi hộp thoại đóng (`confirm`), token biến mất vĩnh viễn vì parent cũng thả
 * response gốc. Không có nút "xem lại" — không thể, vì không bên nào giữ token.
 */
import { ref } from 'vue';
import { useI18n } from '#i18n';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ecoma-io/ui-app-shell';

const { t } = useI18n();

const { token, open } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /** Token show-once — parent giữ và truyền xuống; component không giữ lại. */
    readonly token: string;
    /** Điều khiển mở/đóng từ parent — parent đặt `false` khi token được thả. */
    readonly open: boolean;
  }>();

const emit = defineEmits<{ confirm: [] }>();

const copied = ref(false);

// `navigator.clipboard` chỉ tồn tại ở secure context; app chạy HTTPS trên cả
// local (Traefik TLS) lẫn Workers, nhưng test environment (jsdom) không có —
// nhánh đó tắt nút copy thay vì ném.
const canCopy = typeof navigator !== 'undefined' && navigator.clipboard !== undefined;

async function copy(): Promise<void> {
  if (!canCopy) return;
  await navigator.clipboard.writeText(token);
  copied.value = true;
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('confirm')">
    <DialogContent>
      <DialogHeader>
        <DialogTitle data-testid="remote-cache-app-show-once">
          {{ t('showOnce.title') }}
        </DialogTitle>
        <DialogDescription>{{ t('showOnce.body') }}</DialogDescription>
      </DialogHeader>
      <div class="flex items-center gap-2">
        <code
          class="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all"
          data-testid="remote-cache-app-show-once-token"
          >{{ token }}</code
        >
        <Button v-if="canCopy" variant="outline" size="sm" @click="copy">
          {{ copied ? t('showOnce.copied') : t('showOnce.copy') }}
        </Button>
      </div>
      <DialogFooter>
        <Button data-testid="remote-cache-app-show-once-confirm" @click="emit('confirm')">
          {{ t('showOnce.confirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
