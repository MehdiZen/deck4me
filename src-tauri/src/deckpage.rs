//! La page affichée par le widget suit les modificateurs TENUS.
//!
//! ─── Pourquoi ça marche alors que le hook ne marchait pas ───────────────────
//! `GetAsyncKeyState` n'écoute rien : il DEMANDE l'état d'une touche, à
//! l'instant où on l'appelle. Aucun hook, aucune place dans une chaîne, rien
//! que Windows puisse refuser de livrer à ce processus — et c'est précisément
//! ce qu'il refusait de faire pour les hooks bas niveau, sans qu'on ait jamais
//! su pourquoi (voir l'en-tête de `deck`).
//!
//! C'est donc l'idée d'origine — tenir un modificateur, voir la page changer —
//! récupérée par le seul chemin qui fonctionne ici. Le déclenchement, lui,
//! reste à `RegisterHotKey` : ce module ne déclenche rien et n'avale rien.
//!
//! ─── Ce que ça coûte ────────────────────────────────────────────────────────
//! Trois appels système toutes les cinquante millisecondes, et uniquement quand
//! le widget est visible. C'est une lecture de tableau côté noyau : à cette
//! cadence, c'est indétectable.

use tauri::{AppHandle, Emitter, Manager};

/// Cadence d'interrogation. Cinquante millisecondes : l'œil ne distingue pas
/// mieux sur un affichage qui n'est pas une animation, et descendre plus bas
/// n'achèterait rien de perceptible.
const TICK_MS: u64 = 50;

const VK_SHIFT: i32 = 0x10;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12; // Alt

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vk: i32) -> i16;
}

/// Les trois modificateurs tenus, dans l'ordre (Ctrl, Maj, Alt).
#[cfg(windows)]
fn held() -> (bool, bool, bool) {
    // Le bit de poids fort dit « enfoncée en ce moment ». Le bit de poids
    // faible dit « pressée depuis le dernier appel » et se consommerait à la
    // lecture : l'utiliser ferait clignoter la page.
    let down = |vk| unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 };
    (down(VK_CONTROL), down(VK_SHIFT), down(VK_MENU))
}

#[cfg(not(windows))]
fn held() -> (bool, bool, bool) {
    (false, false, false)
}

/// La page dont les modificateurs correspondent EXACTEMENT à ce qui est tenu.
///
/// Exactement, et non « au moins » : sinon `Ctrl+Alt` déclencherait aussi la
/// page d'`Alt`, et la première page définie gagnerait toujours. On lit les
/// mêmes chaînes que celles enregistrées auprès de Windows, pour qu'affichage
/// et déclenchement ne puissent pas diverger.
pub fn page_for(mods: &[String], ctrl: bool, shift: bool, alt: bool) -> Option<u8> {
    mods.iter().position(|m| {
        let mut want = (false, false, false);
        for part in m.split('+') {
            match part.trim().to_ascii_lowercase().as_str() {
                "ctrl" | "control" | "cmdorctrl" => want.0 = true,
                "shift" | "maj" => want.1 = true,
                "alt" | "option" => want.2 = true,
                _ => return false, // touche inconnue : on ne devine pas
            }
        }
        want == (ctrl, shift, alt)
    })
    .map(|i| i as u8)
}

/// Démarre l'interrogation. Idempotent : un seul fil pour la vie du processus.
pub fn start(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ON: AtomicBool = AtomicBool::new(false);
    if ON.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<u8> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
            let mods = {
                let state = app.state::<crate::App>();
                let db = match state.state.store.db.lock() {
                    Ok(db) => db,
                    Err(_) => continue,
                };
                if !db.settings.deck_enabled {
                    continue;
                }
                db.settings.deck_page_mods.clone()
            };
            let (c, s, a) = held();
            // Aucun modificateur tenu : on retombe sur la première page plutôt
            // que sur du vide. Le widget sert d'aide-mémoire au repos, il doit
            // donc toujours montrer quelque chose.
            let page = page_for(&mods, c, s, a).unwrap_or(0);
            if Some(page) != last {
                last = Some(page);
                let _ = app.emit("deck-page", page);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods() -> Vec<String> {
        crate::deck::DEFAULT_PAGE_MODS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn chaque_accord_sa_page() {
        let m = mods(); // ["Alt", "Ctrl+Alt", "Shift+Alt"]
        assert_eq!(page_for(&m, false, false, true), Some(0));
        assert_eq!(page_for(&m, true, false, true), Some(1));
        assert_eq!(page_for(&m, false, true, true), Some(2));
    }

    #[test]
    fn correspondance_exacte_et_non_partielle() {
        let m = mods();
        // Ctrl+Alt ne doit PAS retomber sur la page d'Alt : sans l'égalité
        // stricte, la première page définie gagnerait systématiquement.
        assert_ne!(page_for(&m, true, false, true), Some(0));
        // Rien de tenu, ou une combinaison qu'aucune page ne revendique.
        assert_eq!(page_for(&m, false, false, false), None);
        assert_eq!(page_for(&m, true, true, true), None);
    }

    #[test]
    fn modificateur_inconnu_ignore() {
        // « Alt+F1 » n'est pas une page : on ne devine pas ce qu'il faudrait
        // tenir, on ne la propose jamais.
        let m = vec!["Alt+F1".to_string()];
        assert_eq!(page_for(&m, false, false, true), None);
    }
}
