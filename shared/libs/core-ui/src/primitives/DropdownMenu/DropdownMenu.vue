<script lang="ts">
export interface DropdownMenuEntry {
  /** Visible label (item + heading kinds). */
  label?: string;
  /** Command id emitted on select; required for an actionable item. */
  value?: string;
  /** Right-aligned accelerator hint, e.g. "⌘S". */
  shortcut?: string;
  /** Render a divider (all other fields ignored). */
  separator?: boolean;
  /** Render a non-interactive section heading. */
  heading?: boolean;
  /** Destructive action — painted in the destructive token. */
  danger?: boolean;
  disabled?: boolean;
}
</script>

<script setup lang="ts">
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "reka-ui";
import { cn } from "../../lib/cn";
import { listStaggerDelay } from "../../lib/motion";

/**
 * DropdownMenu — a single button that opens a list of *commands* (roving focus,
 * typeahead, Esc/outside-click close). Built on Reka UI's DropdownMenu. Selecting
 * an item emits `select` with its `value`; the host maps that id to an action so
 * the primitive stays free of app logic — the same data-driven contract as
 * Menubar (which is the persistent menu *strip*; this is one on-demand menu).
 *
 * Reach for `Popover` when the panel is interactive content rather than a command
 * list, and `Select` when the list *is* the field's value.
 */
withDefaults(defineProps<{ items: DropdownMenuEntry[]; open?: boolean }>(), {
  open: undefined,
});
const emit = defineEmits<{ select: [value: string]; "update:open": [value: boolean] }>();

function choose(item: DropdownMenuEntry): void {
  if (item.disabled || item.value === undefined) return;
  emit("select", item.value);
}
</script>

<template>
  <DropdownMenuRoot :open="open" @update:open="$emit('update:open', $event)">
    <DropdownMenuTrigger as-child>
      <slot name="trigger" />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        :side-offset="6"
        align="start"
        :class="
          cn(
            'z-50 min-w-[12rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none',
            // Scoped to the open state (see Select.vue / Popover.vue): keeps a
            // closed menu from stranding an input-blocking overlay in Reka's
            // Presence while it waits for an animationend that never re-fires.
            'data-[state=open]:animate-scale-in',
          )
        "
        style="transform-origin: var(--reka-popper-transform-origin)"
      >
        <template v-for="(item, i) in items" :key="i">
          <DropdownMenuSeparator v-if="item.separator" class="my-1 h-px bg-border" />
          <DropdownMenuLabel
            v-else-if="item.heading"
            class="px-2 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {{ item.label }}
          </DropdownMenuLabel>
          <DropdownMenuItem
            v-else
            :disabled="item.disabled"
            :class="
              cn(
                'flex cursor-pointer items-center justify-between gap-6 rounded-sm px-2 py-1.5 text-sm text-foreground outline-none',
                'transition-colors duration-fast ease-out',
                // Rows reveal in a capped stagger as the menu opens (same
                // idiom as Select's option list); the hover colour transition
                // above is independent of this mount animation.
                'animate-fade-rise',
                'data-[highlighted]:bg-subtle',
                'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
                item.danger &&
                  'text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive',
              )
            "
            :style="{ animationDelay: listStaggerDelay(i) }"
            @select="choose(item)"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.shortcut" class="tabular text-[0.6875rem] text-muted-foreground">
              {{ item.shortcut }}
            </span>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
