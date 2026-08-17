//! Deck clavier : des cases sur le pavé numérique, déclenchées par accord.
//!
//! ─── Ce que ça résout ───────────────────────────────────────────────────────
//! Le seul avantage réel d'un boîtier à 70 € n'est pas ses boutons, c'est que
//! chaque touche porte son étiquette. Un pavé numérique nu, non : on y met douze
//! actions, on en retient trois. Le widget rend les douze visibles.
//!
//! ─── Pourquoi des accords et pas des pages au maintien ──────────────────────
//! La première version reposait sur un hook clavier bas niveau, seul capable de
//! dire qu'une touche est TENUE — l'information dont vivait l'idée des pages.
//! Ce hook s'installe sans erreur dans ce processus et n'y reçoit jamais rien.
//!
//! Ont été éliminés, mesure à l'appui : le fil et sa boucle de messages, le
//! handle de module, le profil de compilation, le filtre d'injection, le retrait
//! pour dépassement des 300 ms, l'appartenance à un job, le niveau d'intégrité,
//! l'emplacement du binaire — et le code lui-même, par une seconde sonde
//! indépendante qui ne recevait rien non plus. Le même montage, dans un
//! programme isolé sur la même machine, capture cent cinquante-huit frappes par
//! minute.
//!
//! `RegisterHotKey`, lui, fonctionne ici depuis toujours : c'est ce qui porte
//! les raccourcis globaux. Il ne sait parler que d'accords complets, donc les
//! pages deviennent des combinaisons de modificateurs. On y perd le widget qui
//! s'adapte pendant qu'on tient une touche ; on y gagne un deck qui marche.

/// Les cases du deck, dans l'ordre de lecture du pavé.
///
/// Chaque entrée porte son code physique, son étiquette et le nom attendu par
/// `RegisterHotKey`. Les trois vivent ensemble pour qu'aucune table ne puisse
/// diverger d'une autre : un pavé qui s'affiche mais ne déclenche rien est le
/// pire des deux mondes.
///
/// Trois touches sont délibérément absentes. Verr.Num, parce que c'est la seule
/// touche du pavé qui ait encore une fonction et que la confisquer priverait
/// l'utilisateur du moyen de la récupérer. `+` et `Entrée`, parce qu'elles font
/// deux rangées de haut : elles imposaient une quatrième colonne à toute la
/// grille pour deux cases, et le pavé y perdait la forme carrée qu'on reconnaît
/// d'un coup d'œil.
pub const PAD_KEYS: &[(u32, &str, &str)] = &[
    (0xE035, "/", "NumpadDivide"),
    (0x37, "*", "NumpadMultiply"),
    (0x4A, "-", "NumpadSubtract"),
    (0x47, "7", "Numpad7"),
    (0x48, "8", "Numpad8"),
    (0x49, "9", "Numpad9"),
    (0x4B, "4", "Numpad4"),
    (0x4C, "5", "Numpad5"),
    (0x4D, "6", "Numpad6"),
    (0x4F, "1", "Numpad1"),
    (0x50, "2", "Numpad2"),
    (0x51, "3", "Numpad3"),
    (0x52, "0", "Numpad0"),
    (0x53, ".", "NumpadDecimal"),
];

/// Modificateurs de page par défaut.
///
/// Trois accords qu'aucun logiciel courant ne revendique sur le pavé numérique,
/// et que la main gauche tient sans se déplacer. `Alt` seul redevient
/// utilisable ici : contrairement au hook, `RegisterHotKey` ne réserve que la
/// combinaison COMPLÈTE et n'avale pas le modificateur. `Alt+0233` continue
/// donc d'écrire « é », et Alt+Tab n'est pas touché — les deux problèmes que la
/// version précédente créait.
pub const DEFAULT_PAGE_MODS: [&str; 3] = ["Alt", "Ctrl+Alt", "Shift+Alt"];

/// Nom attendu par `RegisterHotKey` pour un code physique du pavé.
pub fn accel_key(key: u32) -> Option<&'static str> {
    PAD_KEYS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, _, a)| *a)
}

/// Accord complet d'une case : modificateurs de la page, puis touche du pavé.
///
/// Renvoie `None` plutôt qu'un accord bancal si la page n'existe pas, si la
/// touche n'est pas du pavé, ou si le modificateur est vide. Un raccourci mal
/// formé serait refusé à l'enregistrement, et l'utilisateur verrait une case
/// qui ne part jamais sans savoir pourquoi.
pub fn accel(mods: &[String], page: u8, key: u32) -> Option<String> {
    let m = mods.get(page as usize)?;
    if m.trim().is_empty() {
        return None;
    }
    Some(format!("{}+{}", m.trim(), accel_key(key)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods() -> Vec<String> {
        DEFAULT_PAGE_MODS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn accord_complet() {
        assert_eq!(accel(&mods(), 0, 0x4F).as_deref(), Some("Alt+Numpad1"));
        assert_eq!(accel(&mods(), 1, 0x52).as_deref(), Some("Ctrl+Alt+Numpad0"));
        assert_eq!(
            accel(&mods(), 2, 0xE035).as_deref(),
            Some("Shift+Alt+NumpadDivide")
        );
    }

    #[test]
    fn refus_plutot_qu_accord_bancal() {
        // Page inexistante : une case orpheline ne doit pas produire un
        // raccourci que personne n'a demandé.
        assert_eq!(accel(&mods(), 7, 0x4F), None);
        // Touche hors du pavé.
        assert_eq!(accel(&mods(), 0, 0x1C), None);
        // Modificateur vide : « +Numpad1 » serait refusé à l'enregistrement, et
        // la case ne partirait jamais sans que rien ne le dise.
        assert_eq!(accel(&[String::new()], 0, 0x4F), None);
    }

    #[test]
    fn table_coherente() {
        // Verr.Num reste à l'utilisateur ; « + » et « Entrée » déformaient la
        // grille. Quatorze cases, et autant de noms d'accord.
        assert_eq!(PAD_KEYS.len(), 14);
        assert!(PAD_KEYS.iter().all(|(_, _, a)| a.starts_with("Numpad")));
        assert!(!PAD_KEYS.iter().any(|(k, _, _)| *k == 0x45));
    }
}
