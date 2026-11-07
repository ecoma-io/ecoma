<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { AvatarImageProps } from 'reka-ui';
import { AvatarImage } from 'reka-ui';

const { ...props } = defineProps<AvatarImageProps>();
</script>

<template>
  <AvatarImage data-slot="avatar-image" v-bind="props" class="aspect-square size-full">
    <slot />
  </AvatarImage>
</template>
