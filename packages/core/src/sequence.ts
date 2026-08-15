/**
 * Macros : une action déclenchée par un ENCHAÎNEMENT de poses.
 *
 * Pourquoi ça compte au-delà du confort : le nombre de poses distinguables est
 * fini. Le seuil d'une gesture est plafonné par sa distance à sa voisine la
 * plus proche, donc plus on en ajoute, plus les seuils se resserrent — au bout
 * d'une douzaine, le wizard refuse tout. Une séquence de deux poses parmi six
 * offre trente combinaisons sans ajouter la moindre pose à distinguer. Les
 * macros ne sont pas un supplément, elles lèvent le plafond.
 *
 * Second usage, tout aussi important : une séquence ne part JAMAIS par accident.
 * Deux gestes volontaires enchaînés dans une fenêtre courte, c'est hors
 * d'atteinte d'une gesticulation ordinaire. C'est donc là que doivent aller les
 * actions qu'on ne confierait jamais à une pose seule.
 */

export interface MacroDef {
  id: string
  profileId: string
  name: string
  enabled: boolean
  /** Identifiants de gestures, dans l'ordre. Deux ou trois, pas plus : au-delà
   *  personne ne retient, et la fenêtre de temps devient intenable. */
  steps: string[]
  /** Délai maximal entre deux maillons consécutifs. */
  windowMs: number
}

export const MACRO_MIN_STEPS = 2
export const MACRO_MAX_STEPS = 4
export const MACRO_DEFAULT_WINDOW_MS = 1500

/** Avancement d'une macro, pour l'afficher pendant qu'elle se compose. */
export interface MacroProgress {
  macroId: string
  /** Nombre de maillons déjà validés (0 = rien en cours). */
  done: number
  total: number
  /** Instant du dernier maillon validé — sert à afficher le temps restant. */
  lastAt: number
}

interface Track {
  index: number
  lastAt: number
}

/**
 * Observe les déclenchements de gestures et reconnaît les enchaînements.
 *
 * Pure vis-à-vis du temps : `now` est injecté, donc testable sans horloge.
 */
export class SequenceMatcher {
  private macros: MacroDef[] = []
  private tracks = new Map<string, Track>()

  setMacros(macros: MacroDef[]): void {
    this.macros = macros.filter(
      (m) => m.enabled && m.steps.length >= MACRO_MIN_STEPS,
    )
    const keep = new Set(this.macros.map((m) => m.id))
    for (const id of [...this.tracks.keys()]) if (!keep.has(id)) this.tracks.delete(id)
  }

  reset(): void {
    this.tracks.clear()
  }

  /** Gestures qui participent à au moins une macro. */
  gesturesInUse(): Set<string> {
    const out = new Set<string>()
    for (const m of this.macros) for (const s of m.steps) out.add(s)
    return out
  }

  /**
   * À appeler pour CHAQUE déclenchement de gesture. Renvoie les macros
   * complétées par ce déclenchement — en général zéro ou une.
   */
  push(gestureId: string, now: number): MacroDef[] {
    const done: MacroDef[] = []
    for (const m of this.macros) {
      const t = this.tracks.get(m.id) ?? { index: 0, lastAt: 0 }
      const expected = m.steps[t.index]

      if (t.index > 0 && now - t.lastAt > m.windowMs) {
        // Fenêtre expirée : l'enchaînement est rompu. Ce déclenchement peut
        // toutefois en amorcer un nouveau, d'où la réévaluation ci-dessous.
        t.index = 0
      }

      if (m.steps[t.index] === gestureId) {
        t.index++
        t.lastAt = now
        if (t.index >= m.steps.length) {
          done.push(m)
          t.index = 0
        }
      } else if (m.steps[0] === gestureId) {
        // Une pose qui n'était pas la suite attendue mais qui ouvre la macro
        // la redémarre, au lieu de tout perdre. Refaire « OK, OK, 3 » doit
        // marcher : le second OK réamorce.
        t.index = 1
        t.lastAt = now
        if (m.steps.length === 1) {
          done.push(m)
          t.index = 0
        }
      } else if (expected !== undefined) {
        // Pose étrangère à cette macro : l'enchaînement tombe.
        t.index = 0
      }

      this.tracks.set(m.id, t)
    }
    return done
  }

  /** Enchaînements en cours, pour retour visuel. Les fenêtres expirées sont
   *  filtrées à la lecture plutôt que balayées par une minuterie. */
  progress(now: number): MacroProgress[] {
    const out: MacroProgress[] = []
    for (const m of this.macros) {
      const t = this.tracks.get(m.id)
      if (!t || t.index === 0) continue
      if (now - t.lastAt > m.windowMs) continue
      out.push({ macroId: m.id, done: t.index, total: m.steps.length, lastAt: t.lastAt })
    }
    return out
  }
}
