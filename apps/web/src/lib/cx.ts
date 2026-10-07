/** Joins class names and skips the falsy ones. Component variants are written not to conflict, so nothing is merged. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
