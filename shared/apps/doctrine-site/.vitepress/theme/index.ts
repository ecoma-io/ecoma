import DefaultTheme from "vitepress/theme";
import { h } from "vue";

import DocumentLicence from "./DocumentLicence.vue";
import DocumentNotice from "./DocumentNotice.vue";

/**
 * The default theme, plus the three things the site says about a document that
 * the document does not say about itself: the `status:` it declares, the other
 * languages it was published in, and the licence it is published under.
 *
 * All three are rendered from here so each is written once. Put into the
 * documents instead, each would be a sentence repeated across the tree and
 * corrected one file at a time.
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "doc-before": () => h(DocumentNotice),
      "doc-after": () => h(DocumentLicence),
    }),
};
