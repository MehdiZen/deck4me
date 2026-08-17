//! La fenêtre du widget : ce qui la rend utilisable pendant un live.
//!
//! Trois propriétés, et sans les trois elle ne sert à rien :
//!
//! **Elle ne prend jamais le focus.** Une fenêtre qui s'active quand elle
//! apparaît minimise le jeu de plein écran fenêtré et coupe la saisie de celui
//! qui joue. `WS_EX_NOACTIVATE` le garantit au niveau de Windows, pas au niveau
//! de nos appels : même un `show()` maladroit ne pourra pas activer la fenêtre.
//!
//! **Elle est invisible à la capture d'écran.** `WDA_EXCLUDEFROMCAPTURE` retire
//! la fenêtre de tout ce que voit un capteur d'écran — OBS, Streamlabs, Discord,
//! une capture système. Sans ça, quelqu'un qui diffuse son écran entier
//! montrerait son deck à ses spectateurs, ce qui est exactement l'inverse du but.
//! Réservé à Windows 10 2004 et au-dessus ; en dessous l'appel échoue et on le
//! dit, plutôt que de laisser croire que c'est couvert.
//!
//! **Elle ne mange aucun clic.** Hors mode épinglé elle est traversante : le
//! curseur passe au travers comme si elle n'était pas là.

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
    // Traversante par défaut : le widget qu'on regarde sans le toucher.
    let _ = win.set_ignore_cursor_events(true);
    harden(app);
    // Journalisé parce que la panne de cette fenêtre est SILENCIEUSE : elle est
    // transparente et sans bordure, donc « pas créée », « page non chargée » et
    // « fonctionne mais vide » se ressemblent tous les trois à l'écran.
    crate::diag::log("deck", "widget créé");
    Ok(())
}

/// Applique les propriétés qui ne passent pas par l'API Tauri.
#[cfg(windows)]
fn harden(app: &AppHandle) {
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
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
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
fn harden(_app: &AppHandle) {}

/// Montre le widget sur une page donnée, ou le retire.
///
/// Le contenu est décidé côté webview, à partir de l'événement `deck-page` :
/// ici on ne fait que la visibilité. Épinglé, la fenêtre reste et c'est la vue
/// qui grise ses cases.
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

/// Épinglé, le widget accepte les clics ; sinon le curseur le traverse.
///
/// Ce n'est pas un réglage de confort : le widget n'a jamais le focus et
/// s'efface au relâchement de la touche de page, donc rien n'y est atteignable
/// tant qu'il n'est pas épinglé.
pub fn set_pinned(app: &AppHandle, pinned: bool) {
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = win.set_ignore_cursor_events(!pinned);
    if pinned {
        let _ = win.show();
    }
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
