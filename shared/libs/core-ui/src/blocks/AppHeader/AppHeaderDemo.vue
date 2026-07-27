<script setup lang="ts">
import { ref } from "vue";
import { Bell, ChevronDown, Search } from "@lucide/vue";
import AppHeader from "./AppHeader.vue";
import Button from "../../primitives/Button/Button.vue";
import TextField from "../../primitives/TextField/TextField.vue";
import DropdownMenu, {
  type DropdownMenuEntry,
} from "../../primitives/DropdownMenu/DropdownMenu.vue";
import Avatar from "../../primitives/Avatar/Avatar.vue";
import BrandMark from "../../icons/BrandMark";
import Surface from "../../primitives/Surface/Surface.vue";

const query = ref("");

/** Enough rows to scroll under the bar — the pinning is the point of the demo. */
const rows = ["Bản tin video", "Dọn kho mã", "Bài blog theo từ khoá", "Tổng hợp bình luận"];

const orgItems: DropdownMenuEntry[] = [
  { heading: true, label: "Tổ chức" },
  { label: "Ecoma Studio", value: "ecoma-studio" },
  { label: "Xưởng phim Bắc Hà", value: "xuong-phim-bac-ha" },
  { separator: true },
  { label: "Tạo tổ chức mới", value: "create-org" },
];

const notificationItems: DropdownMenuEntry[] = [
  { heading: true, label: "Thông báo" },
  { label: 'Quy trình "Dọn kho mã" đã hoàn tất', value: "workflow-done" },
  { label: "Có 2 thành viên mới chờ duyệt", value: "members-pending" },
];

const userItems: DropdownMenuEntry[] = [
  { label: "Hồ sơ", value: "profile" },
  { label: "Cài đặt", value: "settings" },
  { separator: true },
  { label: "Đăng xuất", value: "logout", danger: true },
];
</script>

<template>
  <!-- The scroll container the bar pins against, framed like the top of an
       app shell — same "prove the pin with a scroll" idiom as PageHeader. -->
  <div class="h-80 overflow-y-auto rounded-lg border border-border">
    <AppHeader aria-label="Thanh điều hướng chính">
      <template #brand>
        <span
          class="grid h-6 w-6 place-items-center rounded-md bg-primary text-primary-foreground"
          aria-hidden="true"
        >
          <BrandMark :size="14" :stroke-width="2" />
        </span>
        <span class="text-sm font-semibold tracking-tight text-foreground">Ecoma</span>
      </template>

      <template #search>
        <TextField v-model="query" type="search" aria-label="Tìm kiếm" placeholder="Tìm kiếm...">
          <template #leading>
            <Search aria-hidden="true" />
          </template>
        </TextField>
      </template>

      <template #orgSwitcher>
        <DropdownMenu :items="orgItems">
          <template #trigger>
            <Button variant="ghost" size="sm">
              Ecoma Studio
              <ChevronDown aria-hidden="true" />
            </Button>
          </template>
        </DropdownMenu>
      </template>

      <template #notifications>
        <DropdownMenu :items="notificationItems">
          <template #trigger>
            <Button variant="ghost" size="icon-sm" aria-label="Thông báo">
              <Bell aria-hidden="true" />
            </Button>
          </template>
        </DropdownMenu>
      </template>

      <template #userMenu>
        <DropdownMenu :items="userItems">
          <template #trigger>
            <Button variant="ghost" size="icon-sm" class="rounded-full p-0" aria-label="Tài khoản">
              <Avatar size="sm" fallback="TT" />
            </Button>
          </template>
        </DropdownMenu>
      </template>
    </AppHeader>
    <div class="flex flex-col gap-2 p-6">
      <Surface v-for="(row, i) in [...rows, ...rows, ...rows]" :key="i" pad="sm">
        <p class="text-body text-foreground">{{ row }}</p>
      </Surface>
    </div>
  </div>
</template>
