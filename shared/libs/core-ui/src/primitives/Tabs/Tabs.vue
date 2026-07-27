<script lang="ts">
export interface TabItem {
  value: string;
  label: string;
  disabled?: boolean;
}
</script>

<script setup lang="ts">
import { TabsContent, TabsIndicator, TabsList, TabsRoot, TabsTrigger } from "reka-ui";

/**
 * Tabs — switch between panels/views, with the active panel's content shown
 * below. For picking one value of a setting with no panel underneath, reach
 * for SegmentedControl instead. Built on Reka UI's Tabs (roving tabindex,
 * arrow-key navigation, a11y sourced from the `tab`/`tabpanel` pattern).
 * Panels are supplied by the host via named slots keyed by each tab's
 * `value` — `<Tabs :tabs="tabs"><template #overview>…</template></Tabs>`.
 */
withDefaults(
  defineProps<{
    modelValue?: string;
    tabs: TabItem[];
  }>(),
  { modelValue: undefined },
);

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <TabsRoot
    :model-value="modelValue"
    orientation="horizontal"
    @update:model-value="$emit('update:modelValue', String($event))"
  >
    <TabsList class="relative inline-flex items-center gap-1 border-b border-border">
      <TabsTrigger
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        :disabled="tab.disabled"
        class="relative px-3 py-2 text-sm text-muted-foreground transition-colors duration-fast ease-out data-[state=active]:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {{ tab.label }}
      </TabsTrigger>
      <TabsIndicator
        class="absolute bottom-0 left-0 h-0.5 bg-primary"
        style="
          width: var(--reka-tabs-indicator-size);
          transform: translateX(var(--reka-tabs-indicator-position));
          transition:
            width var(--dur-fast) var(--ease-spring),
            transform var(--dur-fast) var(--ease-spring);
        "
      />
    </TabsList>
    <TabsContent
      v-for="tab in tabs"
      :key="tab.value"
      :value="tab.value"
      class="animate-fade-rise pt-4 focus-visible:outline-none"
    >
      <slot :name="tab.value" />
    </TabsContent>
  </TabsRoot>
</template>
