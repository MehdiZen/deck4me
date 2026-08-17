//! Deck clavier : des pages au maintien, des cases sur le pavé numérique.
//!
//! ─── Ce que ça résout ───────────────────────────────────────────────────────
//! Le seul avantage réel d'un boîtier à 70 € n'est pas ses boutons, c'est que
//! chaque touche porte son étiquette. Un pavé numérique nu, non : on y met
//! douze actions, on en retient trois. Le deck rend les douze visibles — on
//! tient une touche de page, et le widget montre ce que chaque case ferait.
//!
//! ─── Pourquoi un hook bas niveau et pas RegisterHotKey ──────────────────────
//! `RegisterHotKey` ne parle que de combinaisons complètes : il ne dira jamais
//! « la touche de page est tenue en ce moment », qui est précisément
//! l'information dont le widget vit. Et il ne permet pas d'avaler une touche de
//! façon conditionnelle, ce qui est la seule manière d'empêcher `Alt+pavé`
//! d'écrire des caractères ANSI dans l'application de devant.
//!
//! ─── Identification par code PHYSIQUE ───────────────────────────────────────
//! Tout ce module raisonne en scancode, jamais en code virtuel. Deux raisons,
//! chacune suffisante :
//!   • NumLock éteint, le « 1 » du pavé devient VK_END. Un deck indexé sur le
//!     code virtuel casserait selon un réglage que personne ne regarde jamais.
//!     Le code physique, lui, ne bouge pas.
//!   • `²` n'existe qu'en AZERTY. Sa position physique, sous Échap, existe sur
//!     tous les claviers.
//! Les deux touches étendues du pavé (`/` et Entrée) partagent leur scancode
//! avec une touche du clavier principal : le drapeau étendu est replié dans le
//! haut de l'identifiant, d'où le `| E`.

use std::collections::{HashMap, HashSet};

/// Marque du drapeau « touche étendue », repliée dans l'identifiant.
pub const E: u32 = 0xE000;

/// Les cases du deck, dans l'ordre de lecture du pavé.
///
/// Verr.Num (0x45) est délibérément absent : c'est la seule touche du pavé qui
/// ait encore une fonction, et la confisquer priverait l'utilisateur du moyen
/// de la récupérer.
pub const PAD_KEYS: &[(u32, &str)] = &[
    (0x35 | E, "/"),
    (0x37, "*"),
    (0x4A, "-"),
    (0x47, "7"),
    (0x48, "8"),
    (0x49, "9"),
    (0x4E, "+"),
    (0x4B, "4"),
    (0x4C, "5"),
    (0x4D, "6"),
    (0x4F, "1"),
    (0x50, "2"),
    (0x51, "3"),
    (0x1C | E, "Entrée"),
    (0x52, "0"),
    (0x53, "."),
];

/// Touches de page par défaut : Alt gauche, Verr.Maj, `²`.
///
/// Le critère n'est pas « cette touche est-elle libre » mais « TENIR cette
/// touche a-t-il déjà un sens ailleurs ». C'est ce qui écarte Ctrl et Windows,
/// et ce qui laisse passer Alt : tenir Alt ne fait rien tant qu'aucune autre
/// touche n'arrive — et quand une arrive, on rend la main (voir `Verdict`).
///
/// Alt GAUCHE seulement : AltGr est le même scancode en version étendue, et il
/// sert à `@ # [ ]` en AZERTY.
pub const DEFAULT_PAGES: [u32; 3] = [0x38, 0x3A, 0x29];

pub fn is_pad_key(key: u32) -> bool {
    PAD_KEYS.iter().any(|&(k, _)| k == key)
}

/// Ce que le hook doit faire de la touche qu'il vient de voir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Laisser filer vers l'application de devant.
    Pass,
    /// Ne pas la transmettre. C'est ce qui empêche les codes ANSI.
    Swallow,
    /// Avaler celle-ci, mais rejouer un appui bref de ce scancode.
    ///
    /// C'est le rejeu : une touche de page relâchée sans que rien n'ait été
    /// pressé retrouve sa fonction d'origine. Verr.Maj bascule les majuscules,
    /// `²` écrit `²`. On ne confisque une touche que quand on s'en sert.
    SwallowAndTap(u32),
    /// Rejouer l'APPUI de ce scancode, puis laisser filer la touche courante.
    ///
    /// La sortie de secours d'Alt+Tab : la touche de page était retenue en
    /// attendant de savoir à qui elle appartenait, une touche étrangère
    /// tranche, on rend l'appui au système et on s'efface.
    ReplayDownThenPass(u32),
}

/// Ce que le reste de l'application doit apprendre.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Une case occupée vient d'être pressée — même chemin qu'une gesture.
    Press(String),
    Release(String),
    /// Page tenue, ou plus aucune. Pilote l'affichage du widget.
    Page(Option<u8>),
}

/// Où en est une touche de page entre son appui et son relâchement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Avalée, en attente : on ne sait pas encore si elle sert de page.
    Held,
    /// Une case a été déclenchée. La touche nous appartient, pas de rejeu.
    Used,
    /// Une touche étrangère est arrivée, l'appui a été rendu au système.
    /// Nous n'y touchons plus jusqu'au relâchement.
    Yielded,
}

#[derive(Default)]
pub struct Config {
    /// Scancodes des touches de page. L'index EST le numéro de page.
    pub pages: Vec<u32>,
    /// (page, scancode) → identifiant du propriétaire.
    ///
    /// Ce propriétaire est un `gestureId` au sens du store : gesture, macro ou
    /// case, le chemin de déclenchement ne les distingue pas et n'a pas à le
    /// faire. C'est ce qui permet à une case de déclencher un meme, un son et
    /// une chaîne d'actions sans une ligne de code de plus.
    pub slots: HashMap<(u8, u32), String>,
}

/// L'état vivant du deck. Séparé du hook pour être testable sans clavier.
#[derive(Default)]
pub struct Deck {
    pub cfg: Config,
    held: Option<(u8, Phase)>,
    /// Cases actuellement enfoncées, par répétition automatique interposée.
    down: HashSet<u32>,
}

impl Deck {
    pub fn new(cfg: Config) -> Self {
        Deck {
            cfg,
            held: None,
            down: HashSet::new(),
        }
    }

    /// La page tenue, si le widget doit être visible.
    pub fn page(&self) -> Option<u8> {
        match self.held {
            Some((p, Phase::Held)) | Some((p, Phase::Used)) => Some(p),
            _ => None,
        }
    }

    /// Décide du sort d'une touche. Pure : aucun appel système ici.
    pub fn key(&mut self, key: u32, down: bool) -> (Verdict, Vec<Event>) {
        if let Some(page) = self.cfg.pages.iter().position(|&p| p == key) {
            return self.page_key(page as u8, down);
        }
        match self.held {
            // Rien de tenu : le deck n'existe pas, le clavier est normal.
            None => (Verdict::Pass, vec![]),
            // Main rendue : on ne s'interpose plus sur rien, pas même le pavé.
            // C'est ce qui fait que `Alt+0233` continue d'écrire `é` une fois
            // qu'Alt est repassé au système.
            Some((_, Phase::Yielded)) => (Verdict::Pass, vec![]),
            Some((page, phase)) => {
                if is_pad_key(key) {
                    self.pad_key(page, key, down)
                } else if down && phase == Phase::Held {
                    // Touche étrangère : la page n'en était pas une.
                    self.held = Some((page, Phase::Yielded));
                    let sc = self.cfg.pages[page as usize];
                    (Verdict::ReplayDownThenPass(sc), vec![Event::Page(None)])
                } else {
                    (Verdict::Pass, vec![])
                }
            }
        }
    }

    fn page_key(&mut self, page: u8, down: bool) -> (Verdict, Vec<Event>) {
        if down {
            match self.held {
                // Répétition automatique : tenir une touche produit un flot
                // d'appuis. Sans ce filtre le widget clignoterait trente fois
                // par seconde et rechargerait sa page à chaque image.
                Some((p, _)) if p == page => (Verdict::Swallow, vec![]),
                // Deuxième touche de page pendant la première : la dernière
                // gagne. Une règle explicite plutôt qu'un comportement émergent.
                Some(_) => {
                    let mut evs = self.close(false);
                    self.held = Some((page, Phase::Held));
                    evs.push(Event::Page(Some(page)));
                    (Verdict::Swallow, evs)
                }
                None => {
                    self.held = Some((page, Phase::Held));
                    (Verdict::Swallow, vec![Event::Page(Some(page))])
                }
            }
        } else {
            match self.held {
                Some((p, phase)) if p == page => {
                    let mut evs = self.close(true);
                    let v = match phase {
                        // Rien ne s'est passé : la touche retrouve sa vie.
                        Phase::Held => Verdict::SwallowAndTap(self.cfg.pages[page as usize]),
                        // Elle nous a servi : pas de rejeu, sinon chaque
                        // déclenchement écrirait un `²` en prime.
                        Phase::Used => Verdict::Swallow,
                        // Le système a l'appui, il lui faut le relâchement.
                        // Le lui refuser laisserait Alt collé, indéfiniment.
                        Phase::Yielded => Verdict::Pass,
                    };
                    if phase == Phase::Yielded {
                        evs.clear();
                    }
                    (v, evs)
                }
                // Relâchement d'une touche de page qu'on ne suivait pas.
                _ => (Verdict::Pass, vec![]),
            }
        }
    }

    fn pad_key(&mut self, page: u8, key: u32, down: bool) -> (Verdict, Vec<Event>) {
        let Some(owner) = self.cfg.slots.get(&(page, key)).cloned() else {
            // Case vide : la touche passe. C'est ce qui laisse vivre les codes
            // ANSI sans avoir à désarmer quoi que ce soit — un interrupteur
            // qu'on oublie sur « off » produit le pire ticket de support qui
            // soit : tout fonctionne, et rien ne marche.
            return (Verdict::Pass, vec![]);
        };
        if down {
            if !self.down.insert(key) {
                return (Verdict::Swallow, vec![]); // répétition automatique
            }
            self.held = Some((page, Phase::Used));
            (Verdict::Swallow, vec![Event::Press(owner)])
        } else {
            self.down.remove(&key);
            (Verdict::Swallow, vec![Event::Release(owner)])
        }
    }

    /// Ferme la page courante : relâche ce qui restait enfoncé, puis annonce.
    ///
    /// Relâcher explicitement compte : une case en maintien garderait son meme
    /// affiché pour toujours si l'utilisateur lâche la touche de page en
    /// premier — ce que tout le monde fait, la main gauche partant avant la
    /// droite.
    fn close(&mut self, announce: bool) -> Vec<Event> {
        let mut evs = Vec::new();
        if let Some((page, _)) = self.held {
            for key in std::mem::take(&mut self.down) {
                if let Some(owner) = self.cfg.slots.get(&(page, key)) {
                    evs.push(Event::Release(owner.clone()));
                }
            }
        }
        self.held = None;
        if announce {
            evs.push(Event::Page(None));
        }
        evs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALT: u32 = DEFAULT_PAGES[0];
    const CAPS: u32 = DEFAULT_PAGES[1];
    const N1: u32 = 0x4F;
    const N2: u32 = 0x50;
    const TAB: u32 = 0x0F;

    fn deck() -> Deck {
        let mut slots = HashMap::new();
        slots.insert((0, N1), "owner-a".to_string());
        slots.insert((1, N1), "owner-b".to_string());
        Deck::new(Config {
            pages: DEFAULT_PAGES.to_vec(),
            slots,
        })
    }

    #[test]
    fn clavier_intact_sans_touche_de_page() {
        let mut d = deck();
        assert_eq!(d.key(N1, true), (Verdict::Pass, vec![]));
        assert_eq!(d.key(TAB, true), (Verdict::Pass, vec![]));
    }

    #[test]
    fn page_tenue_puis_relachee_rejoue_la_frappe() {
        let mut d = deck();
        let (v, evs) = d.key(CAPS, true);
        assert_eq!(v, Verdict::Swallow);
        assert_eq!(evs, vec![Event::Page(Some(1))]);
        let (v, evs) = d.key(CAPS, false);
        // Rien ne s'est passé : Verr.Maj doit continuer à faire des majuscules.
        assert_eq!(v, Verdict::SwallowAndTap(CAPS));
        assert_eq!(evs, vec![Event::Page(None)]);
    }

    #[test]
    fn case_occupee_declenche_et_supprime_le_rejeu() {
        let mut d = deck();
        d.key(ALT, true);
        let (v, evs) = d.key(N1, true);
        assert_eq!(v, Verdict::Swallow);
        assert_eq!(evs, vec![Event::Press("owner-a".into())]);
        let (v, evs) = d.key(N1, false);
        assert_eq!(v, Verdict::Swallow);
        assert_eq!(evs, vec![Event::Release("owner-a".into())]);
        // La touche de page a servi : pas de rejeu, sinon un menu s'ouvrirait
        // à chaque déclenchement.
        assert_eq!(d.key(ALT, false).0, Verdict::Swallow);
    }

    #[test]
    fn case_vide_laisse_passer_les_codes_ansi() {
        let mut d = deck();
        d.key(ALT, true);
        assert_eq!(d.key(N2, true), (Verdict::Pass, vec![]));
    }

    #[test]
    fn touche_etrangere_rend_la_main() {
        let mut d = deck();
        d.key(ALT, true);
        // Alt+Tab : on rejoue l'appui d'Alt et on s'efface.
        let (v, evs) = d.key(TAB, true);
        assert_eq!(v, Verdict::ReplayDownThenPass(ALT));
        assert_eq!(evs, vec![Event::Page(None)]);
        assert_eq!(d.page(), None);
        // Main rendue : même le pavé redevient normal.
        assert_eq!(d.key(N1, true), (Verdict::Pass, vec![]));
        // Et le relâchement d'Alt doit atteindre le système, sans quoi Alt
        // resterait collé pour toutes les applications.
        assert_eq!(d.key(ALT, false), (Verdict::Pass, vec![]));
    }

    #[test]
    fn repetition_automatique_ignoree() {
        let mut d = deck();
        assert_eq!(d.key(ALT, true).1, vec![Event::Page(Some(0))]);
        // Les appuis répétés ne doivent produire aucun événement.
        assert_eq!(d.key(ALT, true), (Verdict::Swallow, vec![]));
        d.key(N1, true);
        assert_eq!(d.key(N1, true), (Verdict::Swallow, vec![]));
    }

    #[test]
    fn page_relachee_avant_la_case_relache_quand_meme() {
        let mut d = deck();
        d.key(ALT, true);
        d.key(N1, true);
        // La main gauche part avant la droite : sans ce relâchement, un meme
        // en maintien resterait affiché pour toujours.
        let (_, evs) = d.key(ALT, false);
        assert_eq!(
            evs,
            vec![Event::Release("owner-a".into()), Event::Page(None)]
        );
    }

    #[test]
    fn deuxieme_page_la_derniere_gagne() {
        let mut d = deck();
        d.key(ALT, true);
        let (v, evs) = d.key(CAPS, true);
        assert_eq!(v, Verdict::Swallow);
        assert_eq!(evs, vec![Event::Page(Some(1))]);
        assert_eq!(d.page(), Some(1));
        // La même touche physique donne l'autre propriétaire selon la page.
        assert_eq!(d.key(N1, true).1, vec![Event::Press("owner-b".into())]);
    }

    #[test]
    fn pas_de_verr_num_dans_les_cases() {
        // Confisquer Verr.Num priverait l'utilisateur du moyen de le rallumer.
        assert!(!is_pad_key(0x45));
        assert_eq!(PAD_KEYS.len(), 16);
    }
}
