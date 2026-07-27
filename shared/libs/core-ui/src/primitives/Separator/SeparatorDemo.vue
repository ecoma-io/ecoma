<script setup lang="ts">
import Separator from "./Separator.vue";
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 24rem">
    <div class="flex flex-col gap-3">
      <div>
        <p class="text-sm font-medium text-foreground">Hồ sơ</p>
        <p class="text-xs text-muted-foreground">Thông tin cá nhân và cài đặt tài khoản.</p>
      </div>
      <Separator />
      <div>
        <p class="text-sm font-medium text-foreground">Bảo mật</p>
        <p class="text-xs text-muted-foreground">Mật khẩu, xác thực hai lớp.</p>
      </div>
    </div>

    <div class="flex h-5 items-center gap-3 text-sm text-muted-foreground">
      <span>Cắt</span>
      <Separator orientation="vertical" />
      <span>Sao chép</span>
      <Separator orientation="vertical" />
      <span>Dán</span>
    </div>
  </div>
</template>
