//! Raccourcis clavier globaux.
//!
//! Ce qui les justifie : pendant un live, meme4me n'a pas le focus — le jeu ou
//! OBS l'ont. Une commande qui exige de retrouver la fenêtre arrive toujours
//! trop tard. Le panic en particulier ne passe PAS par le front : le Rust
//! nettoie l'overlay lui-même, puis prévient le Studio. Si la webview est
//! occupée, l'écran est quand même propre.

use crate::server::WsMsg;
use crate::App;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Actions assignables. L'identifiant est la clé persistée dans les réglages ;
/// le libellé n'est là que pour le jour où l'interface le lira d'ici.
pub const ACTIONS: &[(&str, &str)] = &[
    ("panic", "Panic — tout couper"),
    ("resume", "Réactiver les gestures"),
    ("toggle_detection", "Démarrer / arrêter la caméra"),
    ("next_profile", "Profil suivant"),
];

fn fire(app: &AppHandle, action: &str) {
    if action == "panic" {
        app.state::<App>()
            .state
            .broadcast(&WsMsg::Clear { binding_id: None });
    }
    let _ = app.emit("hotkey", action);
}

/// Réenregistre tous les raccourcis d'après les réglages persistés.
/// Idempotent : on repart d'une table vide à chaque appel, ce qui évite de
/// tenir un état de plus (« qui était enregistré avant ? »).
pub fn apply(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;

    let assigned = {
        let state = app.state::<App>();
        let db = state.state.store.db.lock().unwrap();
        db.settings.hotkeys.clone()
    };

    let mut refused: Vec<String> = Vec::new();
    for (action, accel) in assigned {
        if accel.trim().is_empty() {
            continue
        }
        if !ACTIONS.iter().any(|(a, _)| *a == action) {
            continue // réglage écrit par une version plus récente
        }
        let owned = action.clone();
        let registered = gs.on_shortcut(accel.as_str(), move |app, _shortcut, event| {
            // Sans ce filtre, chaque appui compte double (press + release).
            if event.state == ShortcutState::Pressed {
                fire(app, &owned);
            }
        });
        if registered.is_err() {
            refused.push(format!("{accel} ({action})"));
        }
    }

    if refused.is_empty() {
        Ok(())
    } else {
        // Windows accorde un raccourci au premier demandeur : un conflit avec
        // OBS ou Discord se voit ici, pas au moment où l'utilisateur appuie.
        Err(format!(
            "déjà pris par un autre logiciel : {}",
            refused.join(", ")
        ))
    }
}
