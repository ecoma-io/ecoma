<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuItemProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DropdownMenuItem, useForwardProps } from 'reka-ui';
import { cn } from '../../utils';

const {
  class: className = undefined,
  inset = undefined,
  variant = 'default',
  ...props
  // oxlint-disable-next-line vue/max-props
} = defineProps<
  DropdownMenuItemProps & {
    class?: HTMLAttributes['class'];
    inset?: boolean;
    variant?: 'default' | 'destructive';
  }
>();

const forwardedProps = useForwardProps(props);
</script>

<template>
  <DropdownMenuItem
    data-slot="dropdown-menu-item"
    :data-inset="inset ? '' : undefined"
    :data-variant="variant"
    v-bind="forwardedProps"
    :class="
      cn(
        'focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive-foreground data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/40 data-[variant=destructive]:focus:text-destructive-foreground data-[variant=destructive]:*:[svg]:!text-destructive-foreground [&_svg:not([class*=\'text-\'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className,
      )
    "
  >
    <slot />
  </DropdownMenuItem>
</template>
