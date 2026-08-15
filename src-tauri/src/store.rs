//! Store JSON versionné. Déviation assumée vs SQLite+Drizzle du handoff :
//! volume minuscule, migrations = match sur schema_version au chargement.
//! Écriture atomique (fichier temporaire puis rename).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub is_active: bool,
}

/// Les gestures/bindings sont opaques pour le Rust (le core TS est propriétaire
/// du format, featurizerVersion inclus). Le serveur n'a besoin que des champs
/// qu'il lit pour construire les TriggerEvent — le reste passe tel quel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GestureRecord(pub Value);

impl GestureRecord {
    pub fn id(&self) -> Option<&str> {
        self.0.get("id").and_then(Value::as_str)
    }
    pub fn hold_mode(&self) -> &str {
        self.0
            .get("holdMode")
            .and_then(Value::as_str)
            .unwrap_or("fixed_duration")
    }
    /// Absent des enregistrements antérieurs aux profils : ils appartiennent
    /// alors au profil « default », que `normalize_profiles` garantit présent.
    pub fn profile_id(&self) -> Option<&str> {
        self.0
            .get("profileId")
            .and_then(Value::as_str)
            .or(Some("default"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingRecord(pub Value);

impl BindingRecord {
    pub fn id(&self) -> Option<&str> {
        self.0.get("id").and_then(Value::as_str)
    }
    pub fn gesture_id(&self) -> Option<&str> {
        self.0.get("gestureId").and_then(Value::as_str)
    }
    pub fn asset_id(&self) -> Option<&str> {
        self.0.get("assetId").and_then(Value::as_str)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub id: String, // SHA1 du fichier, dédup gratuite
    pub filename: String,
    pub mime: String,
    pub ext: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
}

/// Réglages d'application (phase 6). `#[serde(default)]` partout : une base
/// écrite par une version antérieure se relit sans perdre une gesture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// action → accélérateur Tauri ("CmdOrCtrl+Shift+P"). Vide = non assigné.
    pub hotkeys: std::collections::BTreeMap<String, String>,
    /// Vérification des mises à jour au démarrage.
    pub auto_update_check: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkeys: std::collections::BTreeMap::new(),
            auto_update_check: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Db {
    pub schema_version: u32,
    pub profiles: Vec<Profile>,
    pub gestures: Vec<GestureRecord>,
    pub bindings: Vec<BindingRecord>,
    pub assets: Vec<AssetMeta>,
    /// Asset embarqué servant d'image de test quand une gesture n'a pas de binding.
    pub default_asset_id: Option<String>,
    #[serde(default)]
    pub settings: Settings,
}

impl Default for Db {
    fn default() -> Self {
        Db {
            schema_version: SCHEMA_VERSION,
            profiles: vec![Profile {
                id: "default".into(),
                name: "Défaut".into(),
                is_active: true,
            }],
            gestures: vec![],
            bindings: vec![],
            assets: vec![],
            default_asset_id: None,
            settings: Settings::default(),
        }
    }
}

pub struct Store {
    dir: PathBuf,
    pub db: Mutex<Db>,
}

const TEST_MEME: &[u8] = include_bytes!("../embedded/test-meme.png");

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    hex::encode(Sha1::digest(bytes))
}

/// Reconnaissance par octets d'en-tête — jamais par extension : le nom vient
/// de l'utilisateur, les octets viennent du fichier.
/// Le webm et l'ogg partagent des conteneurs proches de leurs cousins audio ;
/// on tranche sur le conteneur, l'overlay route ensuite sur l'extension.
pub fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    // AVIF/HEIF : conteneur ISO-BMFF, la marque est à l'offset 8 et non à 0.
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"avif" | b"avis" => Some(("image/avif", "avif")),
            _ => None, // mp4/mov : pas de canal alpha exploitable, on refuse
        }
    }
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some(("image/png", "png")),
        [b'G', b'I', b'F', b'8', ..] => Some(("image/gif", "gif")),
        // JPEG : SOI + début du premier marqueur. Pas de transparence — accepté
        // quand même, avec avertissement côté interface : beaucoup de memes
        // fonctionnent très bien en rectangle assumé.
        [0xff, 0xd8, 0xff, ..] => Some(("image/jpeg", "jpg")),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => {
            Some(("image/webp", "webp"))
        }
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => {
            Some(("audio/wav", "wav"))
        }
        [0x1a, 0x45, 0xdf, 0xa3, ..] => Some(("video/webm", "webm")),
        [b'O', b'g', b'g', b'S', ..] => Some(("audio/ogg", "ogg")),
        [b'I', b'D', b'3', ..] => Some(("audio/mpeg", "mp3")),
        // MP3 sans tag ID3 : trame MPEG audio (11 bits de synchro à 1).
        // 0xFFD8 (JPEG) ne collisionne pas : 0xD8 & 0xE0 == 0xC0.
        [0xff, b, ..] if b & 0xe0 == 0xe0 => Some(("audio/mpeg", "mp3")),
        _ => None,
    }
}

/// Un asset audio ne se place pas sur le cadre : il se joue. Les deux familles
/// ne se mélangent jamais dans l'interface, d'où ce prédicat partagé.
pub fn is_audio(mime: &str) -> bool {
    mime.starts_with("audio/")
}

/// Formats sans canal alpha : l'interface prévient que le meme aura un fond,
/// et propose le détourage plutôt que de refuser le fichier.
pub fn is_opaque(mime: &str) -> bool {
    mime == "image/jpeg"
}

/// Identifiants utilisés avant le renommage en meme4me. Les données vivent
/// dans un dossier nommé d'après l'identifiant de l'app : sans reprise, un
/// renommage ferait « disparaître » gestures et calibration.
const LEGACY_APP_IDS: &[&str] = &["dev.facememe.app"];

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dst)?;
        } else if !dst.exists() {
            fs::copy(entry.path(), dst)?;
        }
    }
    Ok(())
}

/// Reprend les données d'une installation précédente si le nouveau dossier
/// est vierge. Copie (pas déplacement) : en cas de retour arrière, l'ancienne
/// version retrouve ses données intactes.
fn adopt_legacy_data(dir: &Path) -> std::io::Result<()> {
    if dir.join("db.json").exists() {
        return Ok(());
    }
    let Some(parent) = dir.parent() else {
        return Ok(());
    };
    for id in LEGACY_APP_IDS {
        let old = parent.join(id);
        if old.join("db.json").exists() {
            copy_dir_all(&old, dir)?;
            break;
        }
    }
    Ok(())
}

fn now_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Invariant tenu à l'ouverture plutôt qu'à chaque lecture : au moins un
/// profil, exactement un actif. Toute l'app peut ensuite supposer que
/// `active_profile()` répond.
fn normalize_profiles(db: &mut Db) {
    if db.profiles.is_empty() {
        db.profiles.push(Profile {
            id: "default".into(),
            name: "Défaut".into(),
            is_active: true,
        });
    }
    if !db.profiles.iter().any(|p| p.is_active) {
        db.profiles[0].is_active = true;
    }
    let mut seen = false;
    for p in db.profiles.iter_mut() {
        if p.is_active {
            if seen {
                p.is_active = false;
            }
            seen = true;
        }
    }
}

impl Store {
    pub fn open(dir: PathBuf) -> std::io::Result<Store> {
        fs::create_dir_all(&dir)?;
        adopt_legacy_data(&dir)?;
        fs::create_dir_all(dir.join("assets"))?;
        let db_path = dir.join("db.json");
        let mut db: Db = match fs::read(&db_path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(db) => db,
                Err(e) => {
                    // Repartir sur une base vierge écraserait des heures
                    // d'enregistrement. On met l'illisible de côté, nommé, pour
                    // pouvoir le récupérer à la main.
                    let backup = dir.join(format!("db.corrompu.{}.json", now_stamp()));
                    let _ = fs::write(&backup, &bytes);
                    eprintln!("db.json illisible ({e}) — sauvegardé dans {}", backup.display());
                    Db::default()
                }
            },
            Err(_) => Db::default(),
        };
        // Migrations futures : match db.schema_version { ... }
        db.schema_version = SCHEMA_VERSION;
        normalize_profiles(&mut db);
        let store = Store {
            dir,
            db: Mutex::new(db),
        };
        store.ensure_default_asset()?;
        store.save()?;
        Ok(store)
    }

    fn ensure_default_asset(&self) -> std::io::Result<()> {
        let db = self.db.lock().unwrap();
        if db.default_asset_id.is_some() {
            return Ok(());
        }
        drop(db);
        let meta = self.write_asset("test-meme4me.png", TEST_MEME)?;
        let mut db = self.db.lock().unwrap();
        db.default_asset_id = Some(meta.id.clone());
        Ok(())
    }

    pub fn save(&self) -> std::io::Result<()> {
        let db = self.db.lock().unwrap();
        let json = serde_json::to_vec_pretty(&*db).expect("db sérialisable");
        atomic_write(&self.dir.join("db.json"), &json)
    }

    /// Écrit le fichier + upsert la meta. Id = SHA1 → même contenu, même id.
    pub fn write_asset(&self, filename: &str, bytes: &[u8]) -> std::io::Result<AssetMeta> {
        let (mime, ext) = sniff(bytes).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "format non supporté (images png/gif/webp, vidéo webm, sons mp3/wav/ogg)",
            )
        })?;
        let id = sha1_hex(bytes);
        let path = self.asset_path(&id);
        if !path.exists() {
            atomic_write(&path, bytes)?;
        }
        let (width, height) = imagesize::blob_size(bytes)
            .map(|s| (s.width as u32, s.height as u32))
            .unwrap_or((0, 0)); // webm : dimensions inconnues, l'overlay lit videoWidth
        let meta = AssetMeta {
            id: id.clone(),
            filename: filename.into(),
            mime: mime.into(),
            ext: ext.into(),
            width,
            height,
            size_bytes: bytes.len() as u64,
        };
        let mut db = self.db.lock().unwrap();
        db.assets.retain(|a| a.id != id);
        db.assets.push(meta.clone());
        Ok(meta)
    }

    pub fn asset_path(&self, id: &str) -> PathBuf {
        self.dir.join("assets").join(id)
    }

    pub fn asset_meta(&self, id: &str) -> Option<AssetMeta> {
        self.db.lock().unwrap().assets.iter().find(|a| a.id == id).cloned()
    }

    /// URL d'asset pour un binding : "/assets/<sha1>.<ext>" — l'extension fait
    /// partie de l'URL pour que l'overlay route image/vidéo sans deviner.
    pub fn asset_url(&self, id: &str) -> Option<String> {
        self.asset_meta(id).map(|m| format!("/assets/{}.{}", m.id, m.ext))
    }

    // ---- calibration (blob opaque, propriété du core TS) ----
    pub fn read_calibration(&self) -> Option<Value> {
        let bytes = fs::read(self.dir.join("calibration.json")).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn write_calibration(&self, value: &Value) -> std::io::Result<()> {
        atomic_write(
            &self.dir.join("calibration.json"),
            &serde_json::to_vec(value).expect("calibration sérialisable"),
        )
    }

    // ---- token de la surface OBS ----
    pub fn load_or_create_token(&self) -> std::io::Result<String> {
        let path = self.dir.join("config.json");
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(t) = v.get("token").and_then(Value::as_str) {
                    return Ok(t.to_string());
                }
            }
        }
        use rand::RngCore;
        let mut buf = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut buf);
        let token = hex::encode(buf);
        atomic_write(&path, serde_json::json!({ "token": token }).to_string().as_bytes())?;
        Ok(token)
    }
}
