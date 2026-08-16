/**
 * Actions : ce qu'un déclencheur FAIT, au-delà d'afficher un meme.
 *
 * Jusqu'ici une gesture (ou une macro) ne savait qu'une chose : envoyer une
 * image dans l'overlay OBS. C'est un cas particulier. Le cas général, c'est
 * « ce geste exécute quelque chose sur cette machine » — ouvrir une app, lancer
 * un morceau, appuyer sur un raccourci qu'un autre logiciel écoute, taper une
 * commande de chat, appeler un webhook. Le meme devient une action parmi
 * d'autres, et l'app sort du stream.
 *
 * Le propriétaire d'une action est une MACRO, et seulement une macro. Une pose
 * seule peut partir par accident ; deux gestes volontaires enchaînés dans une
 * fenêtre courte sont hors d'atteinte d'une gesticulation ordinaire. C'est donc
 * le seul endroit assez sûr pour « ouvre ceci » ou « lance ce script » — et un
 * meme dispose de toute façon déjà de son son.
 *
 * Le champ garde le nom générique `ownerId` : le format n'a pas à connaître la
 * différence, et le déclenchement passe par le même `gesture_fired(id)` pour
 * les deux. C'est l'interface qui tient la règle, pas le schéma.
 *
 * ─── Sur la sécurité ────────────────────────────────────────────────────────
 * Oui, ceci permet d'exécuter des programmes arbitraires. Ce n'est pas une
 * élévation de privilège : la configuration vit dans db.json, et tout ce qui
 * peut écrire ce fichier peut déjà exécuter du code sous ton compte. Le vrai
 * risque est ailleurs — le jour où un profil s'importera depuis l'extérieur,
 * ses actions ne devront JAMAIS suivre en silence. Voir README.
 */

export type ActionKind = 'open' | 'run' | 'keys' | 'text' | 'http' | 'wait'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Enregistrement plat plutôt qu'union discriminée : le Rust le traite comme un
 * Value opaque (comme les bindings), le formulaire n'a qu'un objet à muter, et
 * changer de `kind` en cours d'édition ne perd pas ce qui était déjà saisi.
 */
export interface ActionDef {
  id: string
  /** Gesture ou macro — l'un ou l'autre, le format ne s'en soucie pas. */
  ownerId: string
  kind: ActionKind
  enabled: boolean
  /** Rang d'exécution parmi les actions du même déclencheur. */
  order: number
  /** Étiquette libre. Vide = on affiche un résumé calculé. */
  label: string

  /**
   * Cible, selon le genre :
   *   open — chemin, URL, ou URI applicatif (spotify:, steam:, obsidian:…)
   *   run  — exécutable ou script
   *   keys — accord clavier ("Ctrl+Shift+M", "MediaPlayPause")
   *   text — le texte à taper
   *   http — l'URL
   *   wait — inutilisé
   */
  target: string

  /** run : arguments, UN PAR ENTRÉE. Jamais une ligne à redécouper — c'est ce
   *  redécoupage qui fabrique les injections de commande. */
  args: string[]
  /** run : dossier de travail. Vide = celui de l'exécutable. */
  cwd: string

  method: HttpMethod
  /** http : corps envoyé tel quel. */
  body: string
  /** http : en-têtes en texte libre, « Clé: valeur » par ligne. Une grille
   *  clé/valeur serait plus « propre » et deux fois plus pénible à remplir. */
  headers: string

  /** wait : durée de la pause. */
  waitMs: number

  /** Garde anti-rafale propre à l'action. Une gesture a déjà son temps de repos,
   *  mais une action peut vouloir être bien plus rare que son déclencheur. */
  cooldownMs: number
}

export const ACTION_KINDS: ActionKind[] = ['open', 'run', 'keys', 'text', 'http', 'wait']

export const ACTION_LABELS: Record<ActionKind, string> = {
  open: 'Ouvrir',
  run: 'Exécuter',
  keys: 'Raccourci clavier',
  text: 'Taper du texte',
  http: 'Requête HTTP',
  wait: 'Attendre',
}

export const ACTION_HINTS: Record<ActionKind, string> = {
  open: "Ce que ferait un double-clic : une app, un dossier, un site, ou un lien d'application comme spotify:playlist:…",
  run: "Lance un programme ou un script avec ses arguments. Rien n'est passé à un shell : pas de guillemets à deviner.",
  keys: "Envoie un accord clavier au système. C'est la passerelle universelle — OBS, Discord et Spotify écoutent des raccourcis GLOBAUX, qui leur arrivent même sans être au premier plan.",
  text: "Tape une chaîne comme si tu la saisissais. Attention : ça part dans la fenêtre active au moment du geste, quelle qu'elle soit.",
  http: 'Appelle une URL. Webhook Discord, Home Assistant, pont Hue, Streamer.bot — tout ce qui écoute en HTTP.',
  wait: 'Ne fait rien pendant un temps donné. Sert à espacer deux actions de la même chaîne.',
}

export const ACTION_MAX_WAIT_MS = 30_000
/** Au-delà, ce n'est plus un enchaînement, c'est un script — et il vaut mieux
 *  qu'il soit un vrai script lancé par une action `run`. */
export const ACTION_MAX_PER_OWNER = 12

export function newAction(ownerId: string, order: number): ActionDef {
  return {
    id: crypto.randomUUID(),
    ownerId,
    kind: 'open',
    enabled: true,
    order,
    label: '',
    target: '',
    args: [],
    cwd: '',
    method: 'POST',
    body: '',
    headers: '',
    waitMs: 500,
    cooldownMs: 0,
  }
}

/** Complète un enregistrement venu du disque — une base écrite par une version
 *  antérieure ne doit pas produire de `undefined` dans le formulaire. */
export function normalizeAction(raw: Partial<ActionDef> & { id: string; ownerId: string }): ActionDef {
  const base = newAction(raw.ownerId, raw.order ?? 0)
  return {
    ...base,
    ...raw,
    args: Array.isArray(raw.args) ? raw.args : [],
    enabled: raw.enabled !== false,
  }
}

/**
 * Ce qui empêche l'action de fonctionner, dit en français, ou `null`.
 * Les noms de touches ne sont PAS validés ici : la table fait autorité côté
 * Rust et l'interface la lit par `key_names()`. Dupliquer la liste, c'est
 * garantir qu'elle divergera.
 */
export function validateAction(a: ActionDef): string | null {
  const t = a.target.trim()
  switch (a.kind) {
    case 'open':
      return t ? null : 'Indique quoi ouvrir.'
    case 'run':
      return t ? null : 'Indique le programme à lancer.'
    case 'keys':
      return t ? null : 'Choisis une touche.'
    case 'text':
      return a.target ? null : 'Le texte est vide.'
    case 'http':
      if (!/^https?:\/\/./i.test(t)) return "L'adresse doit commencer par http:// ou https://."
      return null
    case 'wait':
      if (!(a.waitMs > 0)) return 'La durée doit être positive.'
      if (a.waitMs > ACTION_MAX_WAIT_MS) return `Maximum ${ACTION_MAX_WAIT_MS / 1000} s.`
      return null
  }
}

/** Résumé d'une ligne, pour la liste. L'étiquette de l'utilisateur prime. */
export function describeAction(a: ActionDef): string {
  if (a.label.trim()) return a.label.trim()
  const t = a.target.trim()
  switch (a.kind) {
    case 'open':
      return t || 'Ouvrir…'
    case 'run':
      return [t, ...a.args].filter(Boolean).join(' ') || 'Exécuter…'
    case 'keys':
      return t || 'Raccourci…'
    case 'text':
      return t ? `« ${t.length > 40 ? t.slice(0, 40) + '…' : t} »` : 'Texte…'
    case 'http':
      return `${a.method} ${t || '…'}`
    case 'wait':
      return `${a.waitMs} ms`
  }
}

/** Actions d'un déclencheur, dans l'ordre d'exécution. */
export function actionsOf(all: ActionDef[], ownerId: string): ActionDef[] {
  return all.filter((a) => a.ownerId === ownerId).sort((x, y) => x.order - y.order)
}

/**
 * Durée minimale de la chaîne : la somme des pauses. Sert à prévenir quand une
 * chaîne dure plus longtemps que le temps de repos de sa gesture — auquel cas
 * un second déclenchement arriverait pendant que le premier tourne encore.
 */
export function chainDurationMs(list: ActionDef[]): number {
  return list
    .filter((a) => a.enabled && a.kind === 'wait')
    .reduce((sum, a) => sum + a.waitMs, 0)
}
