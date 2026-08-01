import { readFileSync } from "node:fs";
import type { Locale } from "vue-i18n";

const rootPackageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { homepage: string };
const languages = JSON.parse(
  readFileSync(new URL("../../../languages.config.json", import.meta.url), "utf8"),
) as { languages: { code: Locale; label: string }[] };

const firstLanguage = languages.languages[0];
if (firstLanguage == null) {
  throw new Error("languages.config.json must declare a first (canonical) language");
}

export default defineNuxtConfig({
  modules: ["@nuxtjs/i18n"],

  app: {
    head: {
      charset: "utf-8",
      viewport: "width=device-width, initial-scale=1",
    },
  },

  runtimeConfig: {
    public: {
      preview: false,
    },
  },

  i18n: {
    strategy: "prefix_except_default",
    defaultLocale: firstLanguage.code,
    locales: languages.languages.map(({ code, label }) => ({
      code,
      language: code,
      name: label,
    })),
    detectBrowserLanguage: false,
    baseUrl: rootPackageJson.homepage,
  },
});
