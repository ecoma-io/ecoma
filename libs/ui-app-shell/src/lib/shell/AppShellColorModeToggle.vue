<script setup lang="ts">
import { Monitor, Moon, Sun } from '@lucide/vue';
import { computed } from 'vue';
import type { AppShellColorMode } from '../color-mode';
import { Button } from '../ui/button';
import { useAppShell } from './context';
import { DEFAULT_APP_SHELL_LABELS } from './labels';
import type { AppShellColorModeLabels } from './types';

/**
 * Nút đổi color mode — UI duy nhất còn lại của cấu hình shell sau khi bảng
 * tuỳ chỉnh (bảng màu + LTR/RTL) bị gỡ (issue #213). Nút bấm **xoay vòng** qua
 * ba chế độ `light → dark → system`, đúng pattern toggle phổ biến nhất cho ba
 * giá trị mà không cần dropdown.
 *
 * Icon hiển thị mode **hiện tại** (không phải mode đích): người dùng nhìn vào
 * biết ngay giao diện đang ở chế độ nào; label tiếng nói cũng mô tả trạng thái
 * hiện tại kèm chế độ kế tiếp để trình đọc màn hình nói được hành vi bấm.
 *
 * Component **không** tự ghi cookie hay đụng DOM: `setColorMode` phát yêu cầu lên
 * `AppShell` (→ app ghi cookie), còn class `dark` do watcher của `AppShell` cập
 * nhật. Một nguồn sự thật duy nhất, không có đường nào ghi class lẻ tẻ.
 */
const { labels = DEFAULT_APP_SHELL_LABELS.colorMode } = defineProps<{
  labels?: AppShellColorModeLabels;
}>();

const { colorMode, setColorMode } = useAppShell();

const NEXT_MODE: Readonly<Record<AppShellColorMode, AppShellColorMode>> = Object.freeze({
  light: 'dark',
  dark: 'system',
  system: 'light',
});

const ICONS: Readonly<Record<AppShellColorMode, typeof Sun>> = Object.freeze({
  light: Sun,
  dark: Moon,
  system: Monitor,
});

const MODE_NAMES: Readonly<Record<AppShellColorMode, (labels: AppShellColorModeLabels) => string>> =
  Object.freeze({
    light: (l) => l.light,
    dark: (l) => l.dark,
    system: (l) => l.system,
  });

const currentIcon = computed(() => ICONS[colorMode.value]);
const announcement = computed(
  () =>
    `${labels.label}: ${MODE_NAMES[colorMode.value](labels)} → ${MODE_NAMES[NEXT_MODE[colorMode.value]](labels)}`,
);
</script>

<template>
  <Button
    variant="ghost"
    size="icon"
    :title="announcement"
    :aria-label="announcement"
    @click="setColorMode(NEXT_MODE[colorMode])"
  >
    <component :is="currentIcon" :size="16" />
  </Button>
</template>
