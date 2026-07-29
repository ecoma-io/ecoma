const H1 = /^#\s+(.+?)\s*$/m;

/**
 * A document's title: its own `# H1`, falling back to the file stem when it
 * has none.
 *
 * The heading wins on purpose. A navigation entry that restates a title the
 * document already carries is a second place to change it, and the two drift
 * the first time someone renames a heading without opening the nav.
 */
export function extractTitle(markdown: string, path: string): string {
  const heading = H1.exec(markdown);
  if (heading) return heading[1];
  const stem = path.split("/").pop() ?? path;
  return stem.replace(/\.md$/, "");
}
