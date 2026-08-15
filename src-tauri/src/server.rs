//! Serveur local axum : page overlay, assets, WS /events.
//! 127.0.0.1 n'est PAS une frontière de sécurité pour un navigateur :
//! toute la surface OBS exige le token de session (?t=), et l'upgrade WS
//! vérifie l'Origin (les WebSocket ignorent la same-origin policy).

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use crate::store::Store;

pub const DEFAULT_PORT: u16 = 47821;

const OVERLAY_HTML: &str = include_str!("../../packages/overlay/dist/overlay.html");

/// Contrat d'événement [FIGÉ] — miroir exact des types TS de @meme4me/core.
/// Le test `ws_contract_is_camel_case` verrouille l'isomorphisme.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub url: String,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEvent {
    pub binding_id: String,
    pub asset_url: String,
    /// Rendu v2 : centre en % du cadre, largeur en % de la largeur du cadre.
    pub x: f64,
    pub y: f64,
    pub size_pct: f64,
    pub duration_ms: u64,
    pub enter: String,
    pub exit: String,
    pub layer: i32,
    pub hold: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<Sound>,
    /// Rempli au moment de la diffusion, renvoyé tel quel par l'overlay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WsMsg {
    Preload { assets: Vec<String> },
    Trigger(TriggerEvent),
    Release { binding_id: String },
    Clear { binding_id: Option<String> },
    Reload,
}

impl WsMsg {
    pub fn to_json(&self) -> String {
        // Le tag externe + contenu aplati : on sérialise à la main pour Trigger
        // afin d'avoir {"type":"trigger", ...champs} et non {"type":"trigger","0":{...}}
        match self {
            WsMsg::Trigger(t) => {
                let mut v = serde_json::to_value(t).expect("trigger sérialisable");
                v.as_object_mut()
                    .unwrap()
                    .insert("type".into(), "trigger".into());
                v.to_string()
            }
            WsMsg::Release { binding_id } => {
                serde_json::json!({ "type": "release", "bindingId": binding_id }).to_string()
            }
            WsMsg::Clear { binding_id } => match binding_id {
                Some(id) => serde_json::json!({ "type": "clear", "bindingId": id }).to_string(),
                None => serde_json::json!({ "type": "clear" }).to_string(),
            },
            WsMsg::Preload { assets } => {
                serde_json::json!({ "type": "preload", "assets": assets }).to_string()
            }
            WsMsg::Reload => serde_json::json!({ "type": "reload" }).to_string(),
        }
    }
}

/// Métrologie du dernier kilomètre (phase 5). On horodate l'émission d'un
/// trigger, l'overlay renvoie le même numéro : la différence est l'aller-retour
/// RÉEL Studio → Rust → WS → navigateur OBS → WS → Rust. Aucune horloge n'est
/// comparée entre documents, donc aucune dérive à corriger.
#[derive(Debug, Default)]
pub struct OverlayMetrics {
    pending: HashMap<u64, std::time::Instant>,
    /// Derniers aller-retours mesurés, en millisecondes (le plus récent en tête).
    pub recent_ms: Vec<f64>,
    pub clients: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStats {
    /// Aller-retour le plus récent, en ms. None tant que rien n'a été mesuré.
    pub last_ms: Option<f64>,
    /// Médiane des mesures retenues — insensible au pic isolé.
    pub median_ms: Option<f64>,
    pub samples: usize,
    /// Nombre de sources de navigateur connectées.
    pub clients: u32,
}

#[derive(Clone)]
pub struct ServerState {
    pub store: Arc<Store>,
    pub token: Arc<String>,
    pub tx: broadcast::Sender<String>,
    seq: Arc<std::sync::atomic::AtomicU64>,
    metrics: Arc<Mutex<OverlayMetrics>>,
}

impl ServerState {
    pub fn new(store: Arc<Store>, token: String) -> ServerState {
        let (tx, _) = broadcast::channel(64);
        ServerState {
            store,
            token: Arc::new(token),
            tx,
            seq: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            metrics: Arc::new(Mutex::new(OverlayMetrics::default())),
        }
    }

    pub fn broadcast(&self, msg: &WsMsg) {
        let _ = self.tx.send(msg.to_json());
    }

    /// Diffuse un trigger en le numérotant, et arme le chronomètre.
    pub fn broadcast_trigger(&self, mut t: TriggerEvent) {
        let seq = self
            .seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        t.seq = Some(seq);
        {
            let mut m = self.metrics.lock().unwrap();
            m.pending.insert(seq, std::time::Instant::now());
            // Un trigger jamais accusé (overlay fermé) ne doit pas fuir.
            if m.pending.len() > 64 {
                let cutoff = std::time::Instant::now() - std::time::Duration::from_secs(10);
                m.pending.retain(|_, at| *at > cutoff);
            }
        }
        self.broadcast(&WsMsg::Trigger(t));
    }

    fn record_ack(&self, seq: u64) {
        let mut m = self.metrics.lock().unwrap();
        let Some(sent) = m.pending.remove(&seq) else {
            return;
        };
        let ms = sent.elapsed().as_secs_f64() * 1000.0;
        m.recent_ms.insert(0, ms);
        m.recent_ms.truncate(30);
    }

    pub fn overlay_stats(&self) -> OverlayStats {
        let m = self.metrics.lock().unwrap();
        let mut sorted = m.recent_ms.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        OverlayStats {
            last_ms: m.recent_ms.first().copied(),
            median_ms: sorted.get(sorted.len() / 2).copied(),
            samples: m.recent_ms.len(),
            clients: m.clients,
        }
    }

    /// Tous les assets référencés par des bindings + l'asset de test :
    /// l'overlay précharge tout à la connexion (latence de décodage sinon).
    pub fn preload_msg(&self) -> WsMsg {
        let db = self.store.db.lock().unwrap();
        let mut ids: Vec<String> = db
            .bindings
            .iter()
            .filter_map(|b| b.asset_id().map(String::from))
            .collect();
        if let Some(d) = &db.default_asset_id {
            ids.push(d.clone());
        }
        drop(db);
        ids.sort();
        ids.dedup();
        let assets = ids.iter().filter_map(|id| self.store.asset_url(id)).collect();
        WsMsg::Preload { assets }
    }
}

fn token_ok(state: &ServerState, q: &HashMap<String, String>) -> bool {
    q.get("t").map(String::as_str) == Some(state.token.as_str())
}

fn origin_ok(headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        // client non-navigateur : pas d'Origin, le token suffit
        None => true,
        Some(o) => o.starts_with("http://127.0.0.1") || o.starts_with("http://localhost"),
    }
}

async fn overlay_page(
    State(state): State<ServerState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !token_ok(&state, &q) {
        return (StatusCode::UNAUTHORIZED, "token invalide").into_response();
    }
    Html(OVERLAY_HTML).into_response()
}

async fn asset(
    State(state): State<ServerState>,
    Path(file): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !token_ok(&state, &q) {
        return (StatusCode::UNAUTHORIZED, "token invalide").into_response();
    }
    // "<40 hex>.<ext>" — jamais de traversée possible
    let id: String = file.chars().take_while(|c| *c != '.').collect();
    if id.len() != 40 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(meta) = state.store.asset_meta(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read(state.store.asset_path(&id)).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, meta.mime.clone()),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable".into()),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn events(
    State(state): State<ServerState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !token_ok(&state, &q) || !origin_ok(&headers) {
        return (StatusCode::UNAUTHORIZED, "token ou origin invalide").into_response();
    }
    ws.on_upgrade(move |socket| client_loop(socket, state))
}

async fn client_loop(mut socket: WebSocket, state: ServerState) {
    let mut rx = state.tx.subscribe();
    if socket
        .send(Message::Text(state.preload_msg().to_json().into()))
        .await
        .is_err()
    {
        return;
    }
    state.metrics.lock().unwrap().clients += 1;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(json) => {
                    if socket.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                // Seul message montant : {"type":"ack","seq":n}
                Some(Ok(Message::Text(txt))) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("ack") {
                            if let Some(seq) = v.get("seq").and_then(|s| s.as_u64()) {
                                state.record_ack(seq);
                            }
                        }
                    }
                }
                Some(Ok(_)) => continue,
                _ => break,
            },
        }
    }
    let mut m = state.metrics.lock().unwrap();
    m.clients = m.clients.saturating_sub(1);
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/overlay", get(overlay_page))
        .route("/assets/{file}", get(asset))
        .route("/events", get(events))
        .with_state(state)
}

/// Démarre le serveur. Retourne le port réellement écouté (utile port 0 en test).
pub async fn start(state: ServerState, port: u16) -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let actual = listener.local_addr()?.port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(state)).await;
    });
    Ok(actual)
}
