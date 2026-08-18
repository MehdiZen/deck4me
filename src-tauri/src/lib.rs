pub mod actions;
mod camfeed;
pub mod deck;
pub mod deckpage;
pub mod deckwin;
pub mod diag;
pub mod fetch;
pub mod hotkeys;
pub mod server;
pub mod store;
pub mod virtualcam;

use base64::Engine;
use serde_json::{json, Value};
use server::{OverlayStats, ServerState, Sound, TriggerEvent, WsMsg, DEFAULT_PORT};
use std::sync::{Arc, Mutex};
use store::{ActionRecord, AssetMeta, BindingRecord, GestureRecord, Profile, Settings, Store};
use tauri::{Emitter, Manager};
use virtualcam::{VcamDevice, VcamFormat, VcamStatus, VirtualCam};

pub struct App {
    pub state: ServerState,
    pub port: u16,
    pub vcam: Arc<VirtualCam>,
    /// Panne du serveur local au démarrage. Sans ce champ, un port 47821 déjà
    /// occupé laissait l'application se lancer parfaitement silencieuse : rien
    /// n'arrivait jamais dans OBS et on cherchait du côté d'OBS.
    pub server_error: Arc<Mutex<Option<String>>>,
    /// Ordonnanceur des actions : temps de repos, chaînes en cours, budget de
    /// lancement. Il vit ici parce qu'il est à l'échelle de l'application —
    /// deux gestures qui partent en même temps partagent le même plafond.
    pub actions: Arc<actions::Runner>,
}

fn overlay_url_of(app: &App) -> String {
    format!("http://127.0.0.1:{}/overlay?t={}", app.port, app.state.token)
}

/// TriggerEvent depuis un binding (Value opaque) + fallback asset de test.
fn build_trigger(app: &App, gesture_id: &str) -> Result<TriggerEvent, String> {
    let store = &app.state.store;
    let db = store.db.lock().unwrap();
    let gesture = db
        .gestures
        .iter()
        .find(|g| g.id() == Some(gesture_id))
        .cloned();
    // Le maintien n'existe QUE pour les poses.
    //
    // `RegisterHotKey` ne signale jamais le relâchement d'un accord : il n'y a
    // pas d'événement de fin à attendre. Un meme de case marqué « tenu » restait
    // donc affiché indéfiniment, l'overlay guettant un signal qui n'arriverait
    // jamais. Une macro est dans le même cas, et c'est déjà pour ça qu'elle vaut
    // `false` : une case du deck n'a aucune raison d'être traitée autrement.
    let hold = gesture
        .as_ref()
        .map(|g| g.hold_mode() == "while_held")
        .unwrap_or(false);
    let binding = db
        .bindings
        .iter()
        .find(|b| b.gesture_id() == Some(gesture_id))
        .cloned();
    let default_asset = db.default_asset_id.clone();
    drop(db);

    let f = |b: &BindingRecord, k: &str| b.0.get(k).cloned();
    match binding {
        Some(b) => {
            let asset_id = b.asset_id().ok_or("binding sans assetId")?.to_string();
            let asset_url = store
                .asset_url(&asset_id)
                .ok_or("asset introuvable pour ce binding")?;
            // Le binding ne stocke qu'un identifiant d'asset : c'est ici, au
            // moment du trigger, que l'URL jetonnée est fabriquée. Le jeton ne
            // transite donc jamais par la base.
            let sound = f(&b, "sound").and_then(|s| {
                let id = s.get("assetId")?.as_str()?;
                Some(Sound {
                    url: store.asset_url(id)?,
                    volume: s.get("volume").and_then(Value::as_f64).unwrap_or(0.8),
                })
            });
            Ok(TriggerEvent {
                binding_id: b.id().unwrap_or("binding").to_string(),
                asset_url,
                x: f(&b, "x").and_then(|v| v.as_f64()).unwrap_or(50.0),
                y: f(&b, "y").and_then(|v| v.as_f64()).unwrap_or(50.0),
                size_pct: f(&b, "sizePct").and_then(|v| v.as_f64()).unwrap_or(25.0),
                duration_ms: f(&b, "durationMs").and_then(|v| v.as_u64()).unwrap_or(3000),
                enter: f(&b, "enter")
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "pop".into()),
                exit: f(&b, "exit")
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "fade".into()),
                layer: f(&b, "layer").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                hold,
                sound,
                seq: None,
            })
        }
        None => {
            // Pas encore de binding : image de test embarquée, pour que la
            // gesture soit démontrable dans OBS dès la phase 3.
            let asset_id = default_asset.ok_or("asset de test manquant")?;
            let asset_url = store.asset_url(&asset_id).ok_or("asset de test manquant")?;
            Ok(TriggerEvent {
                binding_id: format!("test:{gesture_id}"),
                asset_url,
                x: 50.0,
                y: 50.0,
                size_pct: 25.0,
                duration_ms: 2500,
                enter: "pop".into(),
                exit: "fade".into(),
                layer: 0,
                hold,
                sound: None,
                seq: None,
            })
        }
    }
}

fn binding_id_for(app: &App, gesture_id: &str) -> String {
    let db = app.state.store.db.lock().unwrap();
    db.bindings
        .iter()
        .find(|b| b.gesture_id() == Some(gesture_id))
        .and_then(|b| b.id().map(String::from))
        .unwrap_or_else(|| format!("test:{gesture_id}"))
}

// ---- Commands ------------------------------------------------------------

#[tauri::command]
fn bootstrap(app: tauri::State<App>) -> Value {
    let db = app.state.store.db.lock().unwrap();
    json!({
        "profiles": db.profiles,
        "gestures": db.gestures,
        "bindings": db.bindings,
        "macros": db.macros,
        "actions": db.actions,
        "deckSlots": db.deck_slots,
        "assets": db.assets,
        "defaultAssetId": db.default_asset_id,
        "settings": db.settings,
        "overlayUrl": overlay_url_of(&app),
        "hasCalibration": app.state.store.read_calibration().is_some(),
        "port": app.port,
        "version": env!("CARGO_PKG_VERSION"),
        "serverError": *app.server_error.lock().unwrap(),
        "logPath": diag::path(),
    })
}

/// Ouvre le journal dans l'explorateur — le chemin est dans les données
/// d'application, personne ne le trouverait à la main.
#[tauri::command]
fn reveal_log() -> Result<(), String> {
    let path = diag::path().ok_or("journal indisponible")?;
    let mut cmd = std::process::Command::new("explorer");
    // `raw_arg` et non `arg` : explorer veut le mot « /select,"C:\…" » tel
    // quel, alors que `arg` entoure TOUT l'argument de guillemets dès qu'il
    // contient un espace — « "/select,C:\…" » — que explorer ne reconnaît pas.
    //
    // Deux formes fausses déjà essayées : le chemin en second argument (explorer
    // recevait « /select, » seul), puis collé via `arg`. Dans les deux cas le
    // processus se lançait, donc aucune erreur nulle part, et rien à l'écran.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(format!("/select,\"{path}\""));
    }
    #[cfg(not(windows))]
    cmd.arg(&path);
    // explorer.exe renvoie un code non nul même quand il a fait le travail :
    // on ne teste donc pas le statut, seulement le lancement.
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_gesture(app: tauri::State<App>, gesture: Value) -> Result<(), String> {
    let id = gesture
        .get("id")
        .and_then(Value::as_str)
        .ok_or("gesture sans id")?
        .to_string();
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.gestures.retain(|g| g.id() != Some(id.as_str()));
        db.gestures.push(GestureRecord(gesture));
    }
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_gesture(app: tauri::State<App>, id: String) -> Result<(), String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.gestures.retain(|g| g.id() != Some(id.as_str()));
        db.bindings.retain(|b| b.gesture_id() != Some(id.as_str()));
        db.actions.retain(|a| a.owner_id() != Some(id.as_str()));
    }
    store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&WsMsg::Clear { binding_id: None });
    Ok(())
}

// ---- Macros (enchaînements de gestures) ----
//
// Une macro n'a pas besoin de son propre chemin de déclenchement : son binding
// est un binding ordinaire dont le `gestureId` porte l'identifiant de la macro.
// `build_trigger` ne trouve alors aucune gesture (donc hold = false, ce qui est
// exactement le comportement voulu) et trouve le binding. Zéro cas particulier.

#[tauri::command]
fn save_macro(app: tauri::State<App>, macro_def: Value) -> Result<(), String> {
    let id = macro_def
        .get("id")
        .and_then(Value::as_str)
        .ok_or("macro sans id")?
        .to_string();
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.macros.retain(|m| m.id() != Some(id.as_str()));
        db.macros.push(store::MacroRecord(macro_def));
    }
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_macro(app: tauri::State<App>, id: String) -> Result<(), String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.macros.retain(|m| m.id() != Some(id.as_str()));
        db.bindings.retain(|b| b.gesture_id() != Some(id.as_str()));
        db.actions.retain(|a| a.owner_id() != Some(id.as_str()));
    }
    store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&WsMsg::Clear {
        binding_id: Some(id),
    });
    Ok(())
}

#[tauri::command]
fn save_binding(app: tauri::State<App>, binding: Value) -> Result<(), String> {
    let id = binding
        .get("id")
        .and_then(Value::as_str)
        .ok_or("binding sans id")?
        .to_string();
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.bindings.retain(|b| b.id() != Some(id.as_str()));
        db.bindings.push(BindingRecord(binding));
    }
    store.save().map_err(|e| e.to_string())?;
    // Un binding qui change vaut un nouveau préchargement (image ou son ajouté).
    // Pas de reload : il couperait un meme en cours d'affichage à chaque
    // mouvement de curseur dans l'éditeur.
    app.state.broadcast(&app.state.preload_msg());
    Ok(())
}

#[tauri::command]
fn delete_binding(app: tauri::State<App>, id: String) -> Result<(), String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.bindings.retain(|b| b.id() != Some(id.as_str()));
    }
    store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&WsMsg::Clear {
        binding_id: Some(id),
    });
    Ok(())
}

#[tauri::command]
fn upload_asset(
    app: tauri::State<App>,
    filename: String,
    data_base64: String,
) -> Result<AssetMeta, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("base64 invalide: {e}"))?;
    let meta = app
        .state
        .store
        .write_asset(&filename, &bytes)
        .map_err(|e| e.to_string())?;
    app.state.store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&app.state.preload_msg());
    Ok(meta)
}

/// Import depuis une URL. Le téléchargement est bloquant (réseau + disque) :
/// il ne doit jamais s'exécuter sur le thread principal, sinon la fenêtre gèle
/// le temps de la requête.
#[tauri::command]
async fn import_asset_from_url(
    app: tauri::State<'_, App>,
    url: String,
) -> Result<AssetMeta, String> {
    let (bytes, filename) = fetch::download(&url).await.inspect_err(|e| {
        diag::log("import-url", &format!("{url} → {e}"));
    })?;
    let meta = app
        .state
        .store
        .write_asset(&filename, &bytes)
        .map_err(|e| e.to_string())?;
    app.state.store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&app.state.preload_msg());
    diag::log("import-url", &format!("{} ({} o) ← {url}", meta.filename, meta.size_bytes));
    Ok(meta)
}

/// Retire une image ou un son de la bibliothèque.
#[tauri::command]
fn delete_asset(app: tauri::State<App>, id: String) -> Result<(), String> {
    app.state.store.delete_asset(&id)?;
    app.state.store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&app.state.preload_msg());
    Ok(())
}

/// Renvoie les octets d'un asset en base64, pour que le Studio puisse le
/// charger dans un canvas. Passer par l'URL du serveur local marcherait pour
/// AFFICHER l'image, mais elle viendrait d'une autre origine que la webview :
/// le canvas serait teinté et `getImageData` refuserait de rendre les pixels,
/// ce qui interdit tout détourage.
#[tauri::command]
fn read_asset(app: tauri::State<App>, id: String) -> Result<String, String> {
    let meta = app.state.store.asset_meta(&id).ok_or("asset introuvable")?;
    let bytes = std::fs::read(app.state.store.asset_path(&id)).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        meta.mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn get_calibration(app: tauri::State<App>) -> Option<Value> {
    app.state.store.read_calibration()
}

#[tauri::command]
fn save_calibration(app: tauri::State<App>, calibration: Value) -> Result<(), String> {
    app.state
        .store
        .write_calibration(&calibration)
        .map_err(|e| e.to_string())
}

/// Déclenchement, gesture ou macro indifféremment.
///
/// Deux choses en partent, dans cet ordre et sans s'attendre l'une l'autre :
/// la chaîne d'actions (asynchrone — une pause de deux secondes dedans ne doit
/// pas retarder l'image) et le meme.
#[tauri::command]
fn gesture_fired(
    app_handle: tauri::AppHandle,
    app: tauri::State<App>,
    gesture_id: String,
) -> Result<(), String> {
    fire_owner(&app_handle, &app, &gesture_id)
}

/// Le même déclenchement, appelable hors commande Tauri.
///
/// Le deck clavier passe par ici : une case est un déclencheur au même titre
/// qu'une gesture, et rien dans ce chemin n'a besoin de savoir laquelle des
/// trois formes l'a réveillé.
fn fire_owner(
    handle: &tauri::AppHandle,
    app: &App,
    owner_id: &str,
) -> Result<(), String> {
    let has_actions = fire_actions(handle, app, owner_id);

    // Un déclencheur qui n'a QUE des actions n'affiche rien du tout. L'image de
    // test embarquée n'existe que pour rendre une gesture démontrable avant
    // qu'elle ait son meme ; la faire apparaître dans l'overlay de quelqu'un
    // qui s'en sert pour piloter sa machine serait absurde.
    if has_actions && !has_binding(app, owner_id) {
        return Ok(());
    }
    let trigger = build_trigger(app, owner_id)?;
    app.state.broadcast_trigger(trigger);
    Ok(())
}

fn has_binding(app: &App, owner_id: &str) -> bool {
    let db = app.state.store.db.lock().unwrap();
    db.bindings.iter().any(|b| b.gesture_id() == Some(owner_id))
}

/// Lance la chaîne d'actions du déclencheur. Renvoie `true` s'il en avait.
fn fire_actions(handle: &tauri::AppHandle, app: &App, owner_id: &str) -> bool {
    let list: Vec<Value> = {
        let db = app.state.store.db.lock().unwrap();
        db.actions
            .iter()
            .filter(|a| a.owner_id() == Some(owner_id))
            .map(|a| a.0.clone())
            .collect()
    };
    if list.is_empty() {
        return false;
    }
    actions::fire(
        handle.clone(),
        app.actions.clone(),
        actions::parse(&list),
        owner_id.to_string(),
    );
    true
}

// ---- Actions -------------------------------------------------------------

#[tauri::command]
fn save_action(app: tauri::State<App>, action: Value) -> Result<(), String> {
    let id = action
        .get("id")
        .and_then(Value::as_str)
        .ok_or("action sans id")?
        .to_string();
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.actions.retain(|a| a.id() != Some(id.as_str()));
        db.actions.push(ActionRecord(action));
    }
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_action(app: tauri::State<App>, id: String) -> Result<(), String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.actions.retain(|a| a.id() != Some(id.as_str()));
    }
    store.save().map_err(|e| e.to_string())
}

/// Exécute une action seule, et REMONTE son erreur — au contraire du chemin de
/// déclenchement, qui la met au journal. Sans ce bouton, régler un webhook ou un
/// raccourci se ferait à l'aveugle, en se contorsionnant devant la webcam.
#[tauri::command]
async fn test_action(app: tauri::State<'_, App>, action: Value) -> Result<(), String> {
    let parsed = serde_json::from_value::<actions::Action>(action)
        .map_err(|e| format!("action illisible : {e}"))?;
    actions::execute_one(app.actions.clone(), parsed).await
}

/// Noms de touches acceptés. La table vit dans le Rust — l'interface la lit au
/// lieu d'en garder une copie, sinon les deux divergent et l'écart ne se voit
/// qu'au moment où le raccourci ne part pas.
#[tauri::command]
fn key_names() -> Vec<&'static str> {
    actions::key_names()
}

#[tauri::command]
fn gesture_released(app: tauri::State<App>, gesture_id: String) {
    let binding_id = binding_id_for(&app, &gesture_id);
    app.state.broadcast(&WsMsg::Release { binding_id });
}

// ---- Deck clavier -------------------------------------------------------

/// Laisse la webview écrire dans le journal du Rust.
///
/// La fenêtre du widget n'a ni décoration ni focus : sa console n'est ouvrable
/// par personne. Sans ce canal, « le Rust a émis » et « la vue a reçu » sont
/// indiscernables — on les a déjà confondus une fois ici, au prix de plusieurs
/// allers-retours.
#[tauri::command]
fn journal(msg: String) {
    diag::log("vue", &msg);
}

/// Applique l'état du deck : fenêtre du widget, et rien de plus.
///
/// Les accords, eux, sont enregistrés par `hotkeys::apply`, qui les traite
/// exactement comme les raccourcis nommés. Un seul endroit sait parler à
/// Windows du clavier — c'est ce qui manquait à la version précédente, où deux
/// mécanismes concurrents visaient le même pavé.
fn deck_apply(handle: &tauri::AppHandle) {
    let app = handle.state::<App>();
    let (enabled, pinned) = {
        let db = app.state.store.db.lock().unwrap();
        (db.settings.deck_enabled, db.settings.deck_pinned)
    };
    if !enabled {
        // MASQUER, et surtout pas détruire.
        //
        // Le désarmement fermait la fenêtre. Or fermer une fenêtre Tauri est
        // asynchrone : son étiquette reste réservée un court instant après que
        // `get_webview_window` a cessé de la rendre. Réarmer dans cet intervalle
        // faisait échouer la re-création — étiquette déjà prise — et le widget
        // ne revenait plus, jusqu'à une bascule de plus tombée au bon moment.
        // D'où un widget qui « apparaît une fois sur deux ».
        //
        // Rien n'exigeait cette destruction : les accords sont enregistrés par
        // `hotkeys::apply` selon le même drapeau, et l'interrogation des
        // modificateurs se met en pause toute seule quand le deck est désarmé.
        // Une fenêtre masquée ne coûte rien ; une fenêtre recréée à chaque
        // bascule coûte une panne.
        deckwin::show(handle, false);
        return;
    }
    if let Err(e) = deckwin::ensure(handle) {
        // Journalisé ET abandonné ici. Continuer appellerait `set_pinned` sur
        // une fenêtre qui n'existe pas, laquelle ne fait rien en silence : on
        // aurait alors un widget absent sans la moindre trace de la raison.
        diag::log("deck", &format!("widget impossible à créer : {e}"));
        return;
    }
    // Les DEUX réglages sont écrits, parce que « armé » et « visible » sont
    // deux choses différentes et que leur confusion a déjà coûté une panne :
    // armé sans épinglage donne un deck qui fonctionne et un widget invisible,
    // ce qui ressemble beaucoup à un widget cassé.
    diag::log("deck", &format!("widget : armé = {enabled}, épinglé = {pinned}"));
    deckwin::set_pinned(handle, pinned);
    // La page affichée suit les modificateurs tenus. Aucun hook là-dedans :
    // on interroge l'état des touches, ce que Windows n'a jamais refusé.
    deckpage::start(handle);
}

/// Déclenche une case du deck. Appelé depuis l'enregistrement des accords.
pub fn fire_deck_slot(handle: &tauri::AppHandle, owner: &str) {
    let app = handle.state::<App>();
    diag::log("deck", &format!("case {owner} déclenchée"));
    // Le widget allume la case. C'est le SEUL retour visuel du chemin clavier :
    // au clic on voit son propre doigt partir, à la touche on ne voit rien — et
    // un accord qui n'aurait PAS pris ressemblerait exactement à un accord pris.
    // Émis AVANT le déclenchement : une action peut être lente (une macro, un
    // son), l'accusé de réception ne doit pas l'attendre.
    let _ = handle.emit("deck-fired", owner);
    if let Err(e) = fire_owner(handle, &app, owner) {
        diag::log("deck", &format!("case {owner} : {e}"));
    }
}

#[tauri::command]
fn save_deck_slot(
    app_handle: tauri::AppHandle,
    app: tauri::State<App>,
    slot: Value,
) -> Result<(), String> {
    let id = slot
        .get("id")
        .and_then(Value::as_str)
        .ok_or("case sans id")?
        .to_string();
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.deck_slots.retain(|s| s.id() != Some(id.as_str()));
        db.deck_slots.push(store::SlotRecord(slot));
    }
    store.save().map_err(|e| e.to_string())?;
    deck_apply(&app_handle);
    // Une case ajoutée ou déplacée change la table des accords.
    let _ = hotkeys::apply(&app_handle);
    Ok(())
}

#[tauri::command]
fn delete_deck_slot(
    app_handle: tauri::AppHandle,
    app: tauri::State<App>,
    id: String,
) -> Result<(), String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        db.deck_slots.retain(|s| s.id() != Some(id.as_str()));
        // Une case est un déclencheur : elle emporte son meme et ses actions,
        // exactement comme une macro supprimée le fait déjà.
        db.bindings.retain(|b| b.gesture_id() != Some(id.as_str()));
        db.actions.retain(|a| a.owner_id() != Some(id.as_str()));
    }
    store.save().map_err(|e| e.to_string())?;
    deck_apply(&app_handle);
    let _ = hotkeys::apply(&app_handle);
    app.state.broadcast(&WsMsg::Clear {
        binding_id: Some(id),
    });
    Ok(())
}

/// Géométrie du pavé, lue depuis le Rust plutôt que recopiée dans l'interface.
/// Deux tables de codes physiques qui divergent, ça ne se voit qu'au moment où
/// une touche ne déclenche rien.
#[tauri::command]
fn deck_keys() -> Vec<(u32, &'static str, &'static str)> {
    deck::PAD_KEYS.to_vec()
}

/// Aperçu depuis l'éditeur : le binding en cours d'édition n'est pas encore
/// persisté, on diffuse donc l'événement tel quel.
#[tauri::command]
fn preview_binding(app: tauri::State<App>, binding: Value) -> Result<(), String> {
    let store = &app.state.store;
    let asset_id = binding
        .get("assetId")
        .and_then(Value::as_str)
        .ok_or("aperçu sans assetId")?;
    let asset_url = store.asset_url(asset_id).ok_or("asset introuvable")?;
    let g = |k: &str| binding.get(k).cloned();
    let sound = g("sound").and_then(|s| {
        let id = s.get("assetId")?.as_str()?;
        Some(Sound {
            url: store.asset_url(id)?,
            volume: s.get("volume").and_then(Value::as_f64).unwrap_or(0.8),
        })
    });
    app.state.broadcast_trigger(TriggerEvent {
        binding_id: binding
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("preview")
            .to_string(),
        asset_url,
        x: g("x").and_then(|v| v.as_f64()).unwrap_or(50.0),
        y: g("y").and_then(|v| v.as_f64()).unwrap_or(50.0),
        size_pct: g("sizePct").and_then(|v| v.as_f64()).unwrap_or(25.0),
        duration_ms: g("durationMs").and_then(|v| v.as_u64()).unwrap_or(2500),
        enter: g("enter")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "pop".into()),
        exit: g("exit")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "fade".into()),
        layer: g("layer").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        hold: false,
        sound,
        seq: None,
    });
    Ok(())
}

#[tauri::command]
fn panic_clear(app: tauri::State<App>) {
    app.state.broadcast(&WsMsg::Clear { binding_id: None });
}

#[tauri::command]
fn overlay_url(app: tauri::State<App>) -> String {
    overlay_url_of(&app)
}

/// Métrologie du dernier kilomètre — alimente l'écran Debug (phase 5).
#[tauri::command]
fn overlay_stats(app: tauri::State<App>) -> OverlayStats {
    app.state.overlay_stats()
}

// ---- Profils (phase 6) ----

#[tauri::command]
fn save_profile(app: tauri::State<App>, profile: Profile) -> Result<Vec<Profile>, String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        match db.profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(p) => p.name = profile.name,
            None => db.profiles.push(Profile {
                is_active: false, // l'activation est un geste explicite
                ..profile
            }),
        }
    }
    store.save().map_err(|e| e.to_string())?;
    Ok(app.state.store.db.lock().unwrap().profiles.clone())
}

/// Supprimer un profil emporte ses gestures et leurs bindings : garder des
/// gestures orphelines qu'aucun écran n'affiche serait pire.
#[tauri::command]
fn delete_profile(
    app_handle: tauri::AppHandle,
    app: tauri::State<App>,
    id: String,
) -> Result<Value, String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        if db.profiles.len() <= 1 {
            return Err("il faut au moins un profil".into());
        }
        let doomed: Vec<String> = db
            .gestures
            .iter()
            .filter(|g| g.profile_id() == Some(id.as_str()))
            .filter_map(|g| g.id().map(String::from))
            .collect();
        db.gestures
            .retain(|g| g.profile_id() != Some(id.as_str()));
        // Les macros du profil partent avec lui, ainsi que leurs bindings :
        // une macro orpheline désignerait des gestures qui n'existent plus.
        let doomed_macros: Vec<String> = db
            .macros
            .iter()
            .filter(|m| m.profile_id() == Some(id.as_str()))
            .filter_map(|m| m.id().map(String::from))
            .collect();
        db.macros.retain(|m| m.profile_id() != Some(id.as_str()));
        // Et les cases du deck, pour la même raison : une case survivante
        // garderait une touche du pavé confisquée au nom d'un profil disparu.
        let doomed_slots: Vec<String> = db
            .deck_slots
            .iter()
            .filter(|s| s.profile_id() == Some(id.as_str()))
            .filter_map(|s| s.id().map(String::from))
            .collect();
        db.deck_slots.retain(|s| s.profile_id() != Some(id.as_str()));
        let orphan = |owner: Option<&str>| match owner {
            Some(o) => {
                doomed.iter().any(|d| d == o)
                    || doomed_macros.iter().any(|d| d == o)
                    || doomed_slots.iter().any(|d| d == o)
            }
            None => false,
        };
        db.bindings.retain(|b| !orphan(b.gesture_id()));
        // Les actions partent avec leur déclencheur. En laisser une derrière,
        // c'est laisser sur la machine un « lance ce script » que plus aucun
        // écran n'affiche et que plus rien ne peut supprimer.
        db.actions.retain(|a| !orphan(a.owner_id()));
        let was_active = db
            .profiles
            .iter()
            .any(|p| p.id == id && p.is_active);
        db.profiles.retain(|p| p.id != id);
        if was_active {
            db.profiles[0].is_active = true;
        }
    }
    store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&WsMsg::Clear { binding_id: None });
    // Les cases du profil supprimé sont parties : leurs accords aussi, sinon
    // une touche resterait réservée au nom de ce qui n'existe plus.
    let _ = hotkeys::apply(&app_handle);
    let db = store.db.lock().unwrap();
    Ok(json!({
        "profiles": db.profiles,
        "gestures": db.gestures,
        "bindings": db.bindings,
        "macros": db.macros,
        "actions": db.actions,
        "deckSlots": db.deck_slots,
    }))
}

#[tauri::command]
fn set_active_profile(
    app_handle: tauri::AppHandle,
    app: tauri::State<App>,
    id: String,
) -> Result<Vec<Profile>, String> {
    let store = &app.state.store;
    {
        let mut db = store.db.lock().unwrap();
        if !db.profiles.iter().any(|p| p.id == id) {
            return Err("profil inconnu".into());
        }
        for p in db.profiles.iter_mut() {
            p.is_active = p.id == id;
        }
    }
    store.save().map_err(|e| e.to_string())?;
    // Changer de profil retire de l'écran les memes de l'ancien.
    app.state.broadcast(&WsMsg::Clear { binding_id: None });
    deck_apply(&app_handle);
    // Et rebranche le pavé sur les cases du NOUVEAU profil : sans ça, les
    // accords du précédent resteraient enregistrés et continueraient de
    // déclencher des cases qui ne sont plus à l'écran.
    let _ = hotkeys::apply(&app_handle);
    Ok(store.db.lock().unwrap().profiles.clone())
}

// ---- Réglages + raccourcis globaux (phase 6) ----

#[tauri::command]
fn save_settings(
    app_handle: tauri::AppHandle,
    app: tauri::State<App>,
    settings: Settings,
) -> Result<(), String> {
    {
        let mut db = app.state.store.db.lock().unwrap();
        db.settings = settings;
    }
    app.state.store.save().map_err(|e| e.to_string())?;
    deck_apply(&app_handle);
    hotkeys::apply(&app_handle)
}

// ---- Caméra virtuelle ----

// Ces trois commandes bloquent (énumération Media Foundation, UAC, ouverture
// de la caméra). Une commande Tauri SYNCHRONE s'exécute sur le thread
// principal : elle y gèlerait la webview. D'où async + spawn_blocking.

#[tauri::command]
async fn vcam_devices() -> Result<Vec<VcamDevice>, String> {
    tauri::async_runtime::spawn_blocking(VirtualCam::devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn vcam_status(app: tauri::State<App>) -> VcamStatus {
    app.vcam.status()
}

#[tauri::command]
async fn vcam_formats(camera_index: u32) -> Result<Vec<VcamFormat>, String> {
    tauri::async_runtime::spawn_blocking(move || VirtualCam::formats(camera_index))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn vcam_start(
    app: tauri::State<'_, App>,
    camera_index: u32,
    format: Option<VcamFormat>,
) -> Result<VcamStatus, String> {
    let vcam = app.vcam.clone();
    tauri::async_runtime::spawn_blocking(move || vcam.start(camera_index, format))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vcam_stop(app: tauri::State<'_, App>) -> Result<VcamStatus, String> {
    let vcam = app.vcam.clone();
    tauri::async_runtime::spawn_blocking(move || vcam.stop())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn vcam_register(app: tauri::State<'_, App>, unregister: bool) -> Result<bool, String> {
    let vcam = app.vcam.clone();
    tauri::async_runtime::spawn_blocking(move || {
        vcam.register(unregister)?;
        Ok::<bool, String>(VirtualCam::is_registered())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Mise à jour (phase 6) ----

/// Interroge le manifeste de mise à jour. Renvoie `null` si l'app est à jour ;
/// une erreur si le canal n'est pas joignable — les deux cas sont montrés tels
/// quels dans Réglages, sans jamais bloquer le démarrage.
#[tauri::command]
async fn check_update(app_handle: tauri::AppHandle) -> Result<Option<Value>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app_handle.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(json!({
            "version": u.version,
            "currentVersion": u.current_version,
            "notes": u.body,
        }))),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Télécharge et installe, puis relance. Rien n'est fait sans clic explicite :
/// une mise à jour surprise pendant un live est un incident, pas un service.
#[tauri::command]
async fn install_update(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app_handle.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("aucune mise à jour disponible")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app_handle.restart();
}

/// Ramène le Studio devant. Rend `false` s'il n'y a plus de Studio à ramener.
///
/// Les trois appels sont nécessaires et ne font pas la même chose : une fenêtre
/// peut être cachée, réduite, ou simplement derrière une autre. N'en faire qu'un
/// laisserait le second lancement sans effet visible dans deux cas sur trois —
/// c'est-à-dire ressembler exactement à « l'application ne se lance pas ».
fn reveal_main(app: &tauri::AppHandle) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    true
}

pub fn run() {
    tauri::Builder::default()
        // UNE SEULE INSTANCE, et ce plugin doit rester le PREMIER enregistré :
        // il court-circuite le démarrage du second processus, donc tout ce qui
        // serait branché avant lui s'exécuterait quand même pour rien.
        //
        // Sans lui, un second lancement allait jusqu'au bout, trouvait le port
        // local déjà pris et s'arrêtait sur ce message — sans caméra, sans
        // overlay, et sans rien à faire d'autre que le fermer. Deux fenêtres
        // identiques dont une seule fonctionne est pire que pas de fenêtre du
        // tout : on ne sait pas laquelle on regarde.
        //
        // Le second processus s'arrête tout seul ; on se contente de ramener
        // celle qui tourne déjà au premier plan.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Pas de Studio à ramener : le processus qui tient le verrou n'a
            // plus de fenêtre. C'est un revenant — fermeture qui n'est pas allée
            // au bout, fil bloqué à l'extinction.
            //
            // Sans ce cas, l'instance unique serait PIRE que le défaut qu'elle
            // corrige : le revenant avalerait tous les lancements suivants, et
            // cliquer sur le raccourci ne ferait plus rien du tout — ni fenêtre,
            // ni message, ni erreur. On préfère le laisser mourir : le clic
            // suivant repartira sur une application neuve.
            if !reveal_main(app) {
                diag::log(
                    "instance",
                    "second lancement reçu alors que le Studio n'existe plus — \
                     ce processus se retire pour laisser la place",
                );
                app.exit(0);
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Fermer le Studio ferme l'application, widget compris.
        //
        // Sans ça : le widget est une SECONDE fenêtre, invisible, et Tauri ne
        // quitte que lorsqu'il n'en reste aucune. Fermer le Studio laissait donc
        // le processus vivant — hook clavier installé, binaire verrouillé, et
        // rien à l'écran pour le faire soupçonner. Une application qu'on ne peut
        // pas quitter est une application cassée, et celle-ci intercepte le
        // clavier de toute la session.
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::Moved(pos) if window.label() == deckwin::LABEL => {
                    let s = window.scale_factor().unwrap_or(1.0);
                    let p = pos.to_logical::<f64>(s);
                    deckwin::remember(app, p.x, p.y);
                }
                tauri::WindowEvent::CloseRequested { .. }
                    if window.label() != deckwin::LABEL =>
                {
                    deckwin::persist(app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            diag::init(&dir);
            let store = Arc::new(Store::open(dir)?);
            let token = store.load_or_create_token()?;
            let state = ServerState::new(store, token);
            let server_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let s2 = state.clone();
            let err_slot = server_error.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start(s2, DEFAULT_PORT).await {
                    let msg = format!(
                        "Le serveur local n'a pas pu démarrer sur le port {DEFAULT_PORT} ({e}). \
                         Un autre logiciel l'occupe, ou une deuxième instance de deck4me tourne \
                         déjà. Tant que ce n'est pas réglé, l'overlay OBS ne recevra rien."
                    );
                    diag::log("serveur", &msg);
                    *err_slot.lock().unwrap() = Some(msg);
                }
            });
            // softcam.dll : ressource du bundle en prod, vendor/ en dev
            let bundled = app
                .path()
                .resource_dir()
                .map(|d| d.join("softcam.dll"))
                .ok()
                .filter(|p| p.exists());
            let dll = bundled.unwrap_or_else(|| {
                std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../vendor/softcam/dist/bin/x64/softcam.dll"
                ))
            });
            app.manage(App {
                state,
                port: DEFAULT_PORT,
                vcam: Arc::new(VirtualCam::new(dll)),
                server_error,
                actions: Arc::new(actions::Runner::default()),
            });
            // Un raccourci déjà pris par un autre logiciel ne doit pas empêcher
            // l'app de démarrer : l'échec est signalé, pas fatal.
            if let Err(e) = hotkeys::apply(app.handle()) {
                diag::log("raccourcis", &e);
            }
            // Le deck n'installe son hook clavier que s'il est armé ET qu'une
            // touche de page est configurée : voir `deck_apply`.
            deck_apply(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_gesture,
            delete_gesture,
            save_binding,
            delete_binding,
            save_macro,
            delete_macro,
            save_action,
            delete_action,
            test_action,
            key_names,
            upload_asset,
            import_asset_from_url,
            read_asset,
            get_calibration,
            save_calibration,
            gesture_fired,
            gesture_released,
            journal,
            save_deck_slot,
            delete_deck_slot,
            deck_keys,
            preview_binding,
            panic_clear,
            overlay_url,
            overlay_stats,
            delete_asset,
            reveal_log,
            save_profile,
            delete_profile,
            set_active_profile,
            save_settings,
            check_update,
            install_update,
            vcam_devices,
            vcam_formats,
            vcam_status,
            vcam_start,
            vcam_stop,
            vcam_register
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de tauri");
}
