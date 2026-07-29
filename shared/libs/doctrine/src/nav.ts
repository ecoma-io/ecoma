/** One document in the tree. `path` is relative to the doctrine root. */
export interface DoctrineDoc {
  path: string;
  title: string;
}

/** One section of the navigation, in the order the caller declared. */
export interface DoctrineSection {
  id: string;
  docs: DoctrineDoc[];
}

/**
 * Groups `docs` into `sectionOrder`, preserving the caller's order inside each
 * section — reading order is a content decision, not this module's.
 *
 * Three refusals, each closing a way a document can vanish unnoticed. A docs
 * site does not fail by crashing; it fails by publishing a page nobody can
 * reach, and nobody reports a page they never knew was there.
 */
export function buildNav(docs: DoctrineDoc[], sectionOrder: string[]): DoctrineSection[] {
  const loose = docs.filter((d) => !d.path.includes("/"));
  if (loose.length > 0) {
    throw new Error(
      `doctrine: every document belongs to a section directory; found at the root: ${loose
        .map((d) => d.path)
        .join(", ")}`,
    );
  }

  const grouped = new Map<string, DoctrineDoc[]>();
  for (const doc of docs) {
    const section = doc.path.split("/")[0];
    const bucket = grouped.get(section);
    if (bucket) bucket.push(doc);
    else grouped.set(section, [doc]);
  }

  const declared = new Set(sectionOrder);
  const unclaimed = [...grouped.keys()].filter((s) => !declared.has(s));
  if (unclaimed.length > 0) {
    throw new Error(
      `doctrine: section(s) present in the tree but absent from the declared order: ${unclaimed.join(", ")}`,
    );
  }

  const empty = sectionOrder.filter((s) => !grouped.has(s));
  if (empty.length > 0) {
    throw new Error(
      `doctrine: section(s) declared in the order but absent from the tree: ${empty.join(", ")}`,
    );
  }

  return sectionOrder.map((id) => ({ id, docs: grouped.get(id) as DoctrineDoc[] }));
}
