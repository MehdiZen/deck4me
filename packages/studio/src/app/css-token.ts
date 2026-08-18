const cache = new Map<string, string>()

/** Valeur d'une variable CSS de `:root`. */
export function cssToken(name: string): string {
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  // Lire coûte un recalcul de style : les toiles qui repeignent à 60 Hz
  // demandaient cinq couleurs par image, pour des valeurs que rien ne fait
  // changer — l'application n'a qu'un seul thème.
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  cache.set(name, v)
  return v
}
