import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Destinations chosen by the user through native dialogs during this session.
 * Export and "open folder" outside the ArtiSVN directory are only allowed here,
 * so a compromised renderer cannot pick arbitrary filesystem locations.
 */
const allowedRoots = new Set<string>()

export function allowUserChosenRoot(path: string): void {
  try {
    allowedRoots.add(realpathSync.native(resolve(path)))
  } catch {
    allowedRoots.add(resolve(path))
  }
}

export function getAllowedOpenRoots(): string[] {
  return Array.from(allowedRoots)
}
