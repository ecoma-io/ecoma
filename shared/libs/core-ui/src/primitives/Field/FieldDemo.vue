<script setup lang="ts">
import { ref } from "vue";
import Field from "./Field.vue";
import TextField from "../TextField/TextField.vue";
import Textarea from "../Textarea/Textarea.vue";

const name = ref("Ada Lovelace");
const email = ref("not-an-email");
const bio = ref("");
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 24rem">
    <Field label="Họ tên" for="field-demo-name" hint="Tên hiển thị công khai" required>
      <TextField id="field-demo-name" v-model="name" placeholder="Nhập họ tên" />
    </Field>

    <Field label="Email" for="field-demo-email" error="Email không đúng định dạng" required>
      <TextField
        id="field-demo-email"
        v-model="email"
        type="email"
        invalid
        placeholder="you@example.com"
      />
    </Field>

    <Field label="Giới thiệu" for="field-demo-bio" hint="Tối đa 200 ký tự">
      <Textarea id="field-demo-bio" v-model="bio" placeholder="Giới thiệu ngắn gọn" />
    </Field>

    <!-- No `for` passed: falls back to a plain <span>, still readable visually. -->
    <Field label="Không có control id">
      <TextField aria-label="Không có control id" placeholder="Không liên kết nhãn" />
    </Field>
  </div>
</template>
