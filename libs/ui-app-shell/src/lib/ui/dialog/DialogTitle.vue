<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DialogTitleProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DialogTitle, useForwardProps } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  DialogTitleProps & { class?: HTMLAttributes['class'] }
>();

const forwardedProps = useForwardProps(props);
</script>

<template>
  <DialogTitle
    data-slot="dialog-title"
    v-bind="forwardedProps"
    :class="cn('text-lg leading-none font-semibold', className)"
  >
    <slot />
  </DialogTitle>
</template>
