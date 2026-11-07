<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuRadioGroupEmits, DropdownMenuRadioGroupProps } from 'reka-ui';
import { DropdownMenuRadioGroup, useForwardPropsEmits } from 'reka-ui';

const { ...props } = defineProps<DropdownMenuRadioGroupProps>();
const emits = defineEmits<DropdownMenuRadioGroupEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <DropdownMenuRadioGroup data-slot="dropdown-menu-radio-group" v-bind="forwarded">
    <slot />
  </DropdownMenuRadioGroup>
</template>
