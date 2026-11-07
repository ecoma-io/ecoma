<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DialogDescriptionProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DialogDescription } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  DialogDescriptionProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <DialogDescription
    data-slot="sheet-description"
    :class="cn('text-muted-foreground text-sm', className)"
    v-bind="props"
  >
    <slot />
  </DialogDescription>
</template>
