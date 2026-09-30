/**
 * Source independence (docs/provenance.md#verification, step 4): two sources count as one if they share a
 * registrable domain or if the text around the quote is a near duplicate (5-word-shingle Jaccard >= 0.6),
 * so twenty copies of one press release count once.
 */
import { words } from './text';

export const SHINGLE_SIZE = 5;
export const SYNDICATION_THRESHOLD = 0.6;

export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length < size) {
    if (w.length > 0) out.add(w.join(' '));
    return out;
  }
  for (let i = 0; i + size <= w.length; i += 1) out.add(w.slice(i, i + size).join(' '));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface IndependenceInput {
  id: string;
  registrableDomain: string;
  context: string;
}

export interface IndependenceResult {
  /** Groups of mutually dependent evidence ids; each group counts as one source. */
  groups: string[][];
  /** Pairs merged because their text is a near duplicate on different domains. */
  syndicated: [string, string][];
}

/** Union-find over "same domain" and "near-duplicate text" edges. */
export function independentGroups(items: readonly IndependenceInput[]): IndependenceResult {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[i] = root;
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const shingled = items.map((item) => shingles(item.context));
  const syndicated: [string, string][] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (!a || !b) continue;
      if (a.registrableDomain === b.registrableDomain) union(i, j);
      else if (jaccard(shingled[i] ?? new Set(), shingled[j] ?? new Set()) >= SYNDICATION_THRESHOLD) {
        union(i, j);
        syndicated.push([a.id, b.id]);
      }
    }
  }
  const byRoot = new Map<number, string[]>();
  items.forEach((item, i) => {
    const root = find(i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), item.id]);
  });
  return { groups: [...byRoot.values()], syndicated };
}
