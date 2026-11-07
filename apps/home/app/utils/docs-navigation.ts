import type { ContentNavigationItem } from '@nuxt/content';

export type SidebarRoot = {
  root: ContentNavigationItem;
  sections: ContentNavigationItem[];
};

/**
 * Bỏ con trùng path với chính node cha.
 *
 * Nuxt Content đưa index page của một section vào `children[0]` với **cùng
 * path** như node section, nên nếu render nguyên cây sẽ có hai link cùng đích
 * (`Getting Started` rồi `Getting Started`). Chuẩn hoá ở đây một lần để mọi
 * consumer (sidebar, landing) nhận cùng một cây sạch.
 */
function withoutSelfChild(node: ContentNavigationItem): ContentNavigationItem[] {
  return (node.children ?? []).filter((child) => child.path !== node.path);
}

export function getDocsRootNavigation(
  locale: string,
  navigation: readonly ContentNavigationItem[],
): SidebarRoot | null {
  const docsRootPath = `/${locale}/docs`;
  function find(item: ContentNavigationItem | undefined): ContentNavigationItem | undefined {
    if (!item) {
      return undefined;
    }
    if (item.path === docsRootPath) {
      return item;
    }
    for (const child of item.children ?? []) {
      const found = find(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  for (const item of navigation) {
    const root = find(item);
    if (root) {
      const sections = withoutSelfChild(root).map((section) => ({
        ...section,
        children: withoutSelfChild(section),
      }));
      return { root, sections };
    }
  }
  return null;
}

export function getSidebarItems(
  locale: string,
  navigation: readonly ContentNavigationItem[],
): ContentNavigationItem[] {
  const docsRoot = getDocsRootNavigation(locale, navigation);
  if (!docsRoot) {
    return [];
  }
  return [{ title: docsRoot.root.title, path: docsRoot.root.path }, ...docsRoot.sections];
}

export function getSectionCards(
  navigation: readonly ContentNavigationItem[],
  currentPath: string,
  sectionDescriptions: Readonly<Record<string, string>>,
): Array<{
  path: string;
  title: string;
  description: string;
  entries: Array<{ path: string; title: string }>;
}> {
  return navigation
    .filter((item) => item.path !== currentPath)
    .map((section) => ({
      path: section.path,
      title: section.title,
      description: sectionDescriptions[section.path] ?? '',
      // Không tin caller đã chuẩn hoá: index page của section (con trùng path
      // với cha) bị loại tại đây nên hàm tự đủ với cây thô từ Nuxt Content.
      entries: withoutSelfChild(section).map((child) => ({
        path: child.path,
        title: child.title,
      })),
    }));
}
