/**
 * The list-reveal stagger vocabulary — one source for the overlay primitives
 * (DropdownMenu, Menubar, Select) and the Motion design page. Each revealed
 * row is delayed one STEP after the previous, capped so a long list does not
 * tail off indefinitely (Rule 14: a value repeated across files is an
 * unsynced config, and this one was repeated in three templates).
 */
export const LIST_STAGGER_STEP_MS = 24;
export const LIST_STAGGER_CAP = 5;

/** Inline `animation-delay` for the i-th revealed row. */
export function listStaggerDelay(i: number): string {
  return `${Math.min(i, LIST_STAGGER_CAP) * LIST_STAGGER_STEP_MS}ms`;
}
