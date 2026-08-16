/**
 * Skills Atoms
 *
 * The catalog snapshot is the source of truth; everything else derives from it.
 * AppShell populates it, NavigationContext reads it for auto-selection, and the
 * mention menu reads the winners.
 */

import { atom } from 'jotai'
import type { CatalogEntry, CatalogSnapshot } from '../../shared/types'

const EMPTY_SNAPSHOT: CatalogSnapshot = {
  revision: '',
  entries: [],
  tiers: [],
  diagnostics: [],
}

/**
 * Full catalog for the active workspace — winners, shadowed entries, tier
 * roots, trust state, and the revision.
 */
export const skillsSnapshotAtom = atom<CatalogSnapshot>(EMPTY_SNAPSHOT)

/**
 * Skills the runtime will actually use: the highest eligible tier per slug,
 * with disabled and untrusted entries already excluded. This is what the model
 * sees, so it is also what the picker should offer.
 */
export const skillsAtom = atom<CatalogEntry[]>((get) =>
  get(skillsSnapshotAtom).entries.filter((entry) => entry.winner)
)

export { EMPTY_SNAPSHOT }
