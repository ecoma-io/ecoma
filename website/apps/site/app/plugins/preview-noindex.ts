import { defineNuxtPlugin, useHead, useRuntimeConfig } from "#imports";

export default defineNuxtPlugin(() => {
  if (useRuntimeConfig().public.preview === true) {
    useHead({ meta: [{ name: "robots", content: "noindex, nofollow" }] });
  }
});
