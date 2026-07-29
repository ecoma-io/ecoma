/** One translation of a canonical document. */
export interface DoctrineVariant {
  lang: string;
  path: string;
}

/** A canonical document together with every translation that travelled with it. */
export interface DoctrineCanonical {
  path: string;
  variants: DoctrineVariant[];
}

/** `<name>.<lang>.md` — the shape a translation's filename takes. */
const VARIANT_FILENAME = /^(.*)\.(\w+)\.md$/;

/**
 * Splits a flat list of document paths into canonical documents, each carrying
 * the translations that belong to it. Input order is preserved, for the reason
 * `buildNav` preserves it: reading order is a content decision, not this
 * module's.
 *
 * **A translation is the same document, not a second one.** `role.vi.md` says
 * what `role.md` says, in another language. Listed beside its canonical it
 * shows a reader one specification twice, which is why it never becomes an
 * entry of its own — and it is returned rather than discarded because it is
 * still a page, one the canonical's own page should offer.
 *
 * `variantLangs` arrives from the caller for the same reason `sectionOrder`
 * does: which languages the workspace publishes is settled in
 * `languages.config.json`, and a list baked in here would be a second answer to
 * a question that file already answers.
 *
 * Refuses a translation whose canonical is absent, closing the hole the three
 * refusals in `buildNav` close: the file is still published, it is reachable
 * from nothing, and no reader reports a page they do not know exists.
 */
export function groupVariants(paths: string[], variantLangs: string[]): DoctrineCanonical[] {
  const canonicals = new Map<string, DoctrineVariant[]>();
  const variants: (DoctrineVariant & { canonicalPath: string })[] = [];

  for (const path of paths) {
    const match = VARIANT_FILENAME.exec(path);
    if (match && variantLangs.includes(match[2])) {
      variants.push({ path, lang: match[2], canonicalPath: `${match[1]}.md` });
    } else {
      canonicals.set(path, []);
    }
  }

  const orphans = variants.filter((v) => !canonicals.has(v.canonicalPath));
  if (orphans.length > 0) {
    throw new Error(
      `doctrine: translation(s) whose canonical document did not travel with them: ${orphans
        .map((o) => `${o.path} (expected ${o.canonicalPath})`)
        .join(", ")}`,
    );
  }

  for (const variant of variants) {
    (canonicals.get(variant.canonicalPath) as DoctrineVariant[]).push({
      lang: variant.lang,
      path: variant.path,
    });
  }

  return [...canonicals].map(([path, variants]) => ({ path, variants }));
}
