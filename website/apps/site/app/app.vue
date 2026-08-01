<script setup lang="ts">
import { useHead, useLocaleHead } from "#imports";

const head = useLocaleHead({ dir: true, lang: true, seo: true });

useHead({
  htmlAttrs: {
    lang: () => head.value.htmlAttrs.lang,
    dir: () => head.value.htmlAttrs.dir,
  },
  link: () => head.value.link,
  meta: () => head.value.meta,
});
</script>

<template>
  <NuxtPage />
</template>
