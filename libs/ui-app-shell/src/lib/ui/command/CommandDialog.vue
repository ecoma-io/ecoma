<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from 'reka-ui';
import { useForwardPropsEmits } from 'reka-ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../dialog';
import Command from './Command.vue';

const {
  title = 'Command Palette',
  description = 'Search for a command to run...',
  ...props
  // oxlint-disable-next-line vue/max-props
} = defineProps<
  DialogRootProps & {
    title?: string;
    description?: string;
  }
>();
const emits = defineEmits<DialogRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <Dialog v-bind="forwarded">
    <DialogContent class="overflow-hidden p-0">
      <DialogHeader class="sr-only">
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <Command>
        <slot />
      </Command>
    </DialogContent>
  </Dialog>
</template>
