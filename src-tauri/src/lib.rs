pub mod server;
pub mod store;
pub mod virtualcam;

use base64::Engine;
use serde_json::{json, Value};
use server::{ServerState, Sound, TriggerEvent, WsMsg, DEFAULT_PORT};
use std::sync::Arc;
use store::{AssetMeta, BindingRecord, GestureRecord, Store};
use tauri::Manager;
use virtualcam::{VcamDevice, VcamStatus, VirtualCam};

pub struct App {
    pub state: ServerState,
    pub port: u16,
    pub vcam: Arc<VirtualCam>,
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
            let sound = f(&b, "sound").and_then(|s| serde_json::from_value::<Sound>(s).ok());
            Ok(TriggerEvent {
                binding_id: b.id().unwrap_or("binding").to_string(),
                asset_url,
                anchor: f(&b, "anchor")
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "center".into()),
                x: f(&b, "x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                y: f(&b, "y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                scale: f(&b, "scale").and_then(|v| v.as_f64()).unwrap_or(1.0),
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
                anchor: "center".into(),
                x: 0.0,
                y: 0.0,
                scale: 1.0,
                duration_ms: 2500,
                enter: "pop".into(),
                exit: "fade".into(),
                layer: 0,
                hold,
                sound: None,
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
        "assets": db.assets,
        "defaultAssetId": db.default_asset_id,
        "overlayUrl": overlay_url_of(&app),
        "hasCalibration": app.state.store.read_calibration().is_some(),
        "port": app.port,
    })
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
    }
    store.save().map_err(|e| e.to_string())?;
    app.state.broadcast(&WsMsg::Clear { binding_id: None });
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
    // Handoff : reload quand un binding change → l'overlay repart propre
    // et reçoit un preload frais à la reconnexion.
    app.state.broadcast(&WsMsg::Reload);
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
    app.state.broadcast(&WsMsg::Reload);
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

#[tauri::command]
fn gesture_fired(app: tauri::State<App>, gesture_id: String) -> Result<(), String> {
    let trigger = build_trigger(&app, &gesture_id)?;
    app.state.broadcast(&WsMsg::Trigger(trigger));
    Ok(())
}

#[tauri::command]
fn gesture_released(app: tauri::State<App>, gesture_id: String) {
    let binding_id = binding_id_for(&app, &gesture_id);
    app.state.broadcast(&WsMsg::Release { binding_id });
}

#[tauri::command]
fn panic_clear(app: tauri::State<App>) {
    app.state.broadcast(&WsMsg::Clear { binding_id: None });
}

#[tauri::command]
fn overlay_url(app: tauri::State<App>) -> String {
    overlay_url_of(&app)
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
async fn vcam_start(app: tauri::State<'_, App>, camera_index: u32) -> Result<VcamStatus, String> {
    let vcam = app.vcam.clone();
    tauri::async_runtime::spawn_blocking(move || vcam.start(camera_index))
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = Arc::new(Store::open(dir)?);
            let token = store.load_or_create_token()?;
            let state = ServerState::new(store, token);
            let s2 = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start(s2, DEFAULT_PORT).await {
                    eprintln!("serveur local KO ({e}) — port {DEFAULT_PORT} occupé ?");
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
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_gesture,
            delete_gesture,
            save_binding,
            delete_binding,
            upload_asset,
            get_calibration,
            save_calibration,
            gesture_fired,
            gesture_released,
            panic_clear,
            overlay_url,
            vcam_devices,
            vcam_status,
            vcam_start,
            vcam_stop,
            vcam_register
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de tauri");
}
