<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ListboxRootEmits, ListboxRootProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { ListboxRoot, useFilter, useForwardPropsEmits } from 'reka-ui';
import { reactive, ref, watch } from 'vue';
import { cn } from '../../utils';
import { provideCommandContext } from '.';

const {
  class: className = undefined,
  modelValue = '',
  ...props
} = defineProps<ListboxRootProps & { class?: HTMLAttributes['class'] }>();

const emits = defineEmits<ListboxRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);

const allItems = ref<Map<string, string>>(new Map());
const allGroups = ref<Map<string, Set<string>>>(new Map());

const { contains } = useFilter({ sensitivity: 'base' });
const filterState = reactive({
  search: '',
  filtered: {
    /** The count of all visible items. */
    count: 0,
    /** Map from visible item id to its search score. */
    items: new Map() as Map<string, number>,
    /** Set of groups with at least one visible item. */
    groups: new Set() as Set<string>,
  },
});

function filterItems(): void {
  if (!filterState.search) {
    filterState.filtered.count = allItems.value.size;
    // Không lọc gì khi không có từ khoá, nhưng vẫn phải xoá kết quả của lần
    // search trước: để lại thì `filtered.items`/`groups` cũ nằm đó và lần
    // search sau đọc nhầm item không còn tồn tại.
    filterState.filtered.items = new Map();
    filterState.filtered.groups = new Set();
    return;
  }

  // Dựng lại cả hai bảng từ đầu, không `set` chồng lên bảng cũ: vòng lặp bên dưới
  // chỉ ghi những id còn nằm trong `allItems`, nên entry của item đã unmount trong
  // lúc có từ khoá sẽ nằm lại vĩnh viễn — và còn làm group chứa nó bị coi là "còn
  // item khớp" (xem `onUnmounted` của `CommandItem`).
  filterState.filtered.groups = new Set();
  filterState.filtered.items = new Map();
  let itemCount = 0;

  // Check which items should be included
  for (const [id, value] of allItems.value) {
    const score = contains(value, filterState.search);
    filterState.filtered.items.set(id, score ? 1 : 0);
    if (score) itemCount++;
  }

  // Check which groups have at least 1 item shown
  for (const [groupId, group] of allGroups.value) {
    for (const itemId of group) {
      if ((filterState.filtered.items.get(itemId) ?? 0) > 0) {
        filterState.filtered.groups.add(groupId);
        break;
      }
    }
  }

  filterState.filtered.count = itemCount;
}

// Một cơ chế đồng bộ duy nhất: `deep: true` trên chính hai registry, không kèm
// revision counter.
//
// Trước đây watcher đọc `filterState.search` và `.size` của hai `Map`, nên chỉ
// bắt được thay đổi **số lượng**. Item/group đăng ký bằng `Map.set`/`Map.delete`
// trong `onMounted`/`onUnmounted`, nên một lượt thay thế trọn trong cùng tick
// (bỏ `banana`, thêm `blueberry`) đưa `.size` về đúng giá trị cũ và watcher
// **không** chạy: bảng `filtered` còn giữ id đã rời đi, và item mới không được
// lọc nên vẫn hiện dù không khớp từ khoá.
//
// `deep: true` đi hết nội dung hai registry chứ không chỉ kích thước. Với `Map`
// của Vue, phép duyệt đọc `.size` (theo dõi ITERATE_KEY) và từng value, nên mọi
// `set`/`delete` đều phát thay đổi dù số lượng có đổi hay không; value lồng là
// `Set` cũng được duyệt tiếp, nên `add`/`delete` trên set con của group cũng
// đánh thức watcher — thứ mà đọc `.size` của `allGroups` không thấy được.
watch(
  [(): string => filterState.search, allItems, allGroups],
  () => {
    filterItems();
  },
  // `immediate` để trạng thái đầu (chưa có item nào) cũng đi qua đúng một đường.
  { immediate: true, deep: true },
);

provideCommandContext({
  allItems,
  allGroups,
  filterState,
});
</script>

<template>
  <ListboxRoot
    data-slot="command"
    v-bind="forwarded"
    :model-value="modelValue"
    :class="
      cn(
        'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md',
        className,
      )
    "
  >
    <slot />
  </ListboxRoot>
</template>
