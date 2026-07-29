<script setup lang="ts">
import { useData, useRoute, withBase } from "vitepress";
import { computed } from "vue";

/**
 * What each `status:` value means to a reader. Every document in the tree
 * declares one, so the sentence is written here once instead of thirty-odd
 * times in the documents themselves. An unrecognised value is shown verbatim
 * rather than suppressed: a status nobody has written a sentence for is still a
 * status the reader is entitled to see.
 */
const STATUS_NOTICE: Record<string, string> = {
  "design-end-state":
    "Design end-state, pre-implementation — what the system is meant to be and why each decision was taken. Not a description of shipped software.",
};

const { frontmatter } = useData();

const status = computed(() => {
  const declared = frontmatter.value.status;
  if (typeof declared !== "string") return undefined;
  return STATUS_NOTICE[declared] ?? declared;
});

/**
 * Injected per page by the site config — see `.vitepress/config.ts`. The links
 * are site-root-relative, so they go through `withBase`: the site is mounted on
 * a path, and an unprefixed href would leave the mount.
 */
const route = useRoute();
const languages = computed(() =>
  ((frontmatter.value.languages ?? []) as { lang: string; label: string; link: string }[]).map(
    (language) => ({ ...language, href: withBase(language.link) }),
  ),
);
</script>

<template>
  <aside v-if="status" class="document-status">{{ status }}</aside>
  <nav v-if="languages.length > 1" class="document-languages" aria-label="Language">
    <a
      v-for="language in languages"
      :key="language.lang"
      :href="language.href"
      :hreflang="language.lang"
      :aria-current="route.path === language.href ? 'page' : undefined"
    >
      {{ language.label }}
    </a>
  </nav>
</template>

<style scoped>
.document-status {
  margin-bottom: 16px;
  padding: 12px 16px;
  border-left: 4px solid var(--vp-c-brand-1);
  border-radius: 4px;
  background-color: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.5;
}

.document-languages {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 14px;
}

.document-languages a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.document-languages a:hover {
  text-decoration: underline;
}
</style>
