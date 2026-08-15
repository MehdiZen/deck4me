//! Tests d'intégration du serveur local — sans webview, tokio pur.

use facememe_lib::server::{self, ServerState, TriggerEvent, WsMsg};
use facememe_lib::store::Store;
use futures_util::StreamExt;
use std::sync::Arc;

const TEST_PNG: &[u8] = include_bytes!("../embedded/test-meme.png");

async fn boot() -> (ServerState, u16, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open(dir.path().to_path_buf()).expect("store"));
    let state = ServerState::new(store, "tok-test".into());
    let port = server::start(state.clone(), 0).await.expect("bind");
    (state, port, dir)
}

#[tokio::test]
async fn overlay_requires_token() {
    let (_state, port, _dir) = boot().await;
    let base = format!("http://127.0.0.1:{port}");
    let c = reqwest::Client::new();
    assert_eq!(c.get(format!("{base}/overlay")).send().await.unwrap().status(), 401);
    assert_eq!(
        c.get(format!("{base}/overlay?t=mauvais")).send().await.unwrap().status(),
        401
    );
    let ok = c.get(format!("{base}/overlay?t=tok-test")).send().await.unwrap();
    assert_eq!(ok.status(), 200);
    let body = ok.text().await.unwrap();
    assert!(body.contains("fm-status"), "page overlay embarquée");
}

#[tokio::test]
async fn assets_roundtrip_and_auth() {
    let (state, port, _dir) = boot().await;
    let meta = state.store.write_asset("meme.png", TEST_PNG).unwrap();
    assert_eq!(meta.mime, "image/png");
    assert_eq!(meta.width, 320);
    let base = format!("http://127.0.0.1:{port}");
    let c = reqwest::Client::new();

    let url = format!("{base}/assets/{}.{}", meta.id, meta.ext);
    assert_eq!(c.get(&url).send().await.unwrap().status(), 401, "token requis");
    let ok = c.get(format!("{url}?t=tok-test")).send().await.unwrap();
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.headers()["content-type"], "image/png");
    assert_eq!(ok.bytes().await.unwrap().len(), TEST_PNG.len());

    // id non-sha1 → 404 sans toucher au disque
    let bad = c
        .get(format!("{base}/assets/..%2F..%2Fdb.json?t=tok-test"))
        .send()
        .await
        .unwrap();
    assert_ne!(bad.status(), 200);
}

#[tokio::test]
async fn ws_preload_then_trigger() {
    let (state, port, _dir) = boot().await;
    let (ws, _) = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{port}/events?t=tok-test"
    ))
    .await
    .expect("connexion ws");
    let (_write, mut read) = ws.split();

    // 1er message : preload (contient l'asset de test embarqué)
    let first = read.next().await.unwrap().unwrap().into_text().unwrap();
    let v: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(v["type"], "preload");
    assert!(v["assets"].as_array().unwrap().len() >= 1);

    state.broadcast(&WsMsg::Trigger(TriggerEvent {
        binding_id: "b1".into(),
        asset_url: "/assets/abc.png".into(),
        anchor: "br".into(),
        x: -2.0,
        y: -4.0,
        scale: 1.5,
        duration_ms: 3000,
        enter: "pop".into(),
        exit: "shrink".into(),
        layer: 2,
        hold: false,
        sound: None,
    }));
    let second = read.next().await.unwrap().unwrap().into_text().unwrap();
    let v: serde_json::Value = serde_json::from_str(&second).unwrap();
    // contrat verrouillé : camelCase, tag "type" aplati
    assert_eq!(v["type"], "trigger");
    assert_eq!(v["bindingId"], "b1");
    assert_eq!(v["assetUrl"], "/assets/abc.png");
    assert_eq!(v["durationMs"], 3000);
    assert_eq!(v["hold"], false);
    assert!(v.get("sound").is_none(), "sound absent si None");
}

#[tokio::test]
async fn ws_rejects_bad_token() {
    let (_state, port, _dir) = boot().await;
    let err = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/events?t=nope")).await;
    assert!(err.is_err(), "l'upgrade doit être refusé sans le bon token");
}

#[test]
fn ws_contract_is_camel_case() {
    let msgs = [
        WsMsg::Release { binding_id: "b".into() },
        WsMsg::Clear { binding_id: None },
        WsMsg::Reload,
        WsMsg::Preload { assets: vec!["/assets/a.png".into()] },
    ];
    let jsons: Vec<String> = msgs.iter().map(WsMsg::to_json).collect();
    assert_eq!(jsons[0], r#"{"bindingId":"b","type":"release"}"#);
    assert_eq!(jsons[1], r#"{"type":"clear"}"#);
    assert_eq!(jsons[2], r#"{"type":"reload"}"#);
    assert!(jsons[3].contains(r#""assets":["/assets/a.png"]"#));
}
