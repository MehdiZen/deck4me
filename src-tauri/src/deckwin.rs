//! La fenêtre du widget : ce qui la rend utilisable pendant un live.
//!
//! Deux propriétés, et une renoncée.
//!
//! **Elle est transparente.** Le panneau a des coins arrondis ; sans
//! transparence, Windows peint du blanc dessous et les quatre angles portent un
//! liseré clair que rien, côté vue, ne peut effacer — il est derrière elle. La
//! transparence sert aussi le rendu voulu : un fond légèrement translucide qui
//! laisse deviner ce qu'il couvre.
//!
//! **Renoncée : ne jamais prendre le focus.** `WS_EX_NOACTIVATE` évitait qu'une
//! fenêtre surgissant par-dessus un jeu ne le minimise. Mais une fenêtre qui ne
//! peut jamais s'activer ne donne pas non plus le focus à sa webview, et une
//! webview sans focus ne traite ni les clics ni le déplacement. Le widget était
//! intouchable ; on préfère un widget qu'on peut utiliser.
//!
//! **Elle est invisible à la capture d'écran.** `WDA_EXCLUDEFROMCAPTURE` retire
//! la fenêtre de tout ce que voit un capteur d'écran — OBS, Streamlabs, Discord,
//! une capture système. Sans ça, quelqu'un qui diffuse son écran entier
//! montrerait son deck à ses spectateurs, ce qui est exactement l'inverse du but.
//! Réservé à Windows 10 2004 et au-dessus ; en dessous l'appel échoue et on le
//! dit, plutôt que de laisser croire que c'est couvert.
//!
//! **Elle se tient hors du chemin.** Retirée d'Alt+Tab et de la barre des
//! tâches par `WS_EX_TOOLWINDOW` : un widget n'est pas une destination.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "deck-hud";

const WIDTH: f64 = 272.0;
const HEIGHT: f64 = 450.0;
/// Marge au bord de l'écran. Le widget se pose en bas à droite, du côté où se
/// trouve le pavé numérique — le regard n'a pas à traverser l'écran.
const MARGIN: f64 = 24.0;

const GWL_EXSTYLE: i32 = -20;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
/// Retire la fenêtre d'Alt+Tab et de la barre des tâches. Un widget n'est pas
/// une destination.
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, new: isize) -> isize;
    fn SetWindowDisplayAffinity(hwnd: isize, affinity: u32) -> i32;
}

/// Crée la fenêtre si elle n'existe pas. Idempotent.
pub fn ensure(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    // La MÊME page que le Studio, aiguillée par l'étiquette de la fenêtre.
    //
    // Une requête (`index.html?window=deck`) a été essayée et retirée : Tauri
    // traite cet argument comme un chemin de fichier, le `?` s'échappe, la page
    // ne se charge pas — et une fenêtre transparente qui ne charge rien est
    // rigoureusement invisible, sans la moindre erreur nulle part. L'étiquette
    // ne dépend d'aucune URL et ne peut pas se faire échapper.
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
    .title("deck4me")
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .decorations(false)
    // TRANSPARENTE, de nouveau.
    //
    // Elle avait été rendue opaque en soupçonnant la transparence d'empêcher
    // les clics et le déplacement. C'était faux : le coupable était
    // `WS_EX_NOACTIVATE`, qui privait la webview de focus. Sans transparence,
    // Windows peignait du blanc sous les coins arrondis du panneau — un liseré
    // clair sur les quatre angles, impossible à faire disparaître depuis la
    // vue puisqu'il est PEINT DERRIÈRE elle.
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    // Créée invisible : sans ça elle clignoterait à chaque démarrage, y compris
    // chez quelqu'un qui ne l'a jamais demandée.
    .visible(false)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;

    // Position retenue si elle existe, sinon en bas à droite de l'écran
    // principal — du côté du pavé numérique, pour que le regard ne traverse pas
    // l'écran.
    let state = app.state::<crate::App>();
    let saved = state
        .state
        .store
        .db
        .lock()
        .ok()
        .and_then(|db| db.settings.deck_pos);
    match saved {
        Some((x, y)) => {
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
        None => {
            if let Ok(Some(mon)) = win.primary_monitor() {
                let size = mon.size().to_logical::<f64>(mon.scale_factor());
                let _ = win.set_position(tauri::LogicalPosition::new(
                    size.width - WIDTH - MARGIN,
                    size.height - HEIGHT - MARGIN,
                ));
            }
        }
    }
    // `.visible(false)` au constructeur ne suffit pas toujours : on le redit
    // une fois la fenêtre placée, sinon elle clignote à sa position par défaut.
    let _ = win.hide();
    harden(app, false);
    // Journalisé parce que la panne de cette fenêtre est SILENCIEUSE : elle est
    // transparente et sans bordure, donc « pas créée », « page non chargée » et
    // « fonctionne mais vide » se ressemblent tous les trois à l'écran.
    crate::diag::log("deck", "widget créé");
    Ok(())
}

/// Applique les propriétés qui ne passent pas par l'API Tauri.
///
/// `WS_EX_NOACTIVATE` est ABANDONNÉ.
///
/// Il empêchait la fenêtre de prendre le focus — souhaitable quand elle
/// apparaissait par-dessus un jeu. Mais une fenêtre qui ne peut jamais
/// s'activer ne donne pas non plus le focus à sa webview, et une webview sans
/// focus ne traite ni les clics ni le déplacement, lequel passe par un clic
/// dans la page. Le widget était donc intouchable, et c'était de ce côté-là,
/// pas du clavier.
///
/// Reste `WS_EX_TOOLWINDOW`, qui le retire d'Alt+Tab et de la barre des tâches
/// sans rien coûter, et l'exclusion de capture, qui est la vraie raison d'être
/// de cette fonction.
#[cfg(windows)]
fn harden(app: &AppHandle, pinned: bool) {
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    let Ok(hwnd) = win.hwnd() else {
        crate::diag::log("deck", "fenêtre du widget sans handle natif");
        return;
    };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let _ = pinned;
        let ex = (ex | WS_EX_TOOLWINDOW) & !WS_EX_NOACTIVATE;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        crate::diag::log(
            "deck",
            &format!("widget : épinglé = {pinned}, style étendu = 0x{ex:X}"),
        );
        if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0 {
            // Windows antérieur à la 2004. Le widget marchera, mais il sera
            // visible en capture d'écran entier : mieux vaut que ce soit écrit
            // quelque part que découvert par un spectateur.
            crate::diag::log(
                "deck",
                "cette version de Windows ne sait pas exclure une fenêtre de la \
                 capture — le widget apparaîtra dans une capture d'écran entier",
            );
        }
    }
}

#[cfg(not(windows))]
fn harden(_app: &AppHandle, _pinned: bool) {}

/// Montre ou retire le widget.
pub fn show(app: &AppHandle, visible: bool) {
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    if visible {
        let _ = win.show();
        // Remonter à chaque affichage : une fenêtre passée derrière un jeu
        // lancé après elle ne reviendrait jamais devant toute seule.
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.hide();
    }
}

/// Affiche ou masque le widget.
///
/// « Épinglé » ne veut plus dire « cliquable » mais simplement « visible ».
/// Depuis que les cases se déclenchent par accord et non plus au maintien
/// d'une touche, le widget n'a plus de raison d'apparaître et de disparaître :
/// il est là, ou il n'est pas là. Et tant qu'il est là, il se clique et se
/// déplace — c'est-à-dire qu'il ne traverse plus jamais les clics, ce qui était
/// précisément ce qui le rendait inutilisable.
pub fn set_pinned(app: &AppHandle, pinned: bool) {
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = win.set_ignore_cursor_events(false);
    harden(app, true);
    let _ = if pinned { win.show() } else { win.hide() };
}

/// Retient la position du widget dans les réglages.
///
/// Appelé au déplacement, mais N'ÉCRIT PAS à chaque pixel : la base fait plus
/// d'un méga-octet, la réécrire soixante fois par seconde pendant qu'on traîne
/// la fenêtre ferait ramer tout le reste. On garde la position en mémoire, et
/// c'est la fermeture qui l'écrit.
pub fn remember(app: &AppHandle, x: f64, y: f64) {
    if let Ok(mut db) = app.state::<crate::App>().state.store.db.lock() {
        db.settings.deck_pos = Some((x, y));
    }
}

/// Écrit sur le disque ce que `remember` a gardé en mémoire.
pub fn persist(app: &AppHandle) {
    let _ = app.state::<crate::App>().state.store.save();
}

pub fn close(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.close();
    }
}
