//! Incrustation d'un meme directement dans le flux de la caméra virtuelle —
//! l'alternative à l'overlay OBS pour Discord, Zoom, Teams ou tout ce qui
//! prend « deck4me Camera » comme webcam.
//!
//! Phase 1, assumée et pas cachée :
//!   · une image ANIMÉE (GIF) n'affiche que sa première image — aucune
//!     boucle, aucun timing de frame. Décoder et jouer une animation sur
//!     chaque image caméra est un moteur en soi, pas ajouté ici.
//!   · aucun son : une image vidéo n'a pas de piste audio, il n'y a nulle
//!     part où l'envoyer.
//!   · un seul meme actif à la fois — le dernier déclenché remplace le
//!     précédent, `layer` n'est pas lu.
//!
//! Le reste (position, taille, entrée/sortie, maintien) reprend exactement
//! `RenderParams`, en pourcentages du cadre — donc valable sur n'importe
//! quelle résolution de caméra sans conversion.

use image::RgbaImage;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

pub struct ActiveOverlay {
    pub asset_id: String,
    pub asset_path: PathBuf,
    pub x_pct: f64,
    pub y_pct: f64,
    pub size_pct: f64,
    pub enter_ms: u64,
    pub duration_ms: u64,
    /// while_held : pas de sortie automatique, on attend `release()`.
    pub hold: bool,
    pub started_at: Instant,
    pub released_at: Option<Instant>,
}

/// Sortie fixe, calée sur `fm-exit-fade` (packages/overlay/src/template.html)
/// pour ressentir le même rythme que le sortie par défaut de l'overlay OBS.
/// L'overlay web a un `exit` configurable par binding ; ce moteur n'en a
/// qu'un, phase 1 oblige.
const EXIT_MS: u64 = 200;

#[derive(Default)]
pub struct CamOverlay {
    active: Mutex<Option<ActiveOverlay>>,
    cache: Mutex<HashMap<String, RgbaImage>>,
}

impl CamOverlay {
    pub fn show(&self, ov: ActiveOverlay) {
        *self.active.lock().unwrap() = Some(ov);
    }

    /// Amorce la sortie d'un while_held. Sans effet sur un one-shot : celui-ci
    /// se retire tout seul à `duration_ms`, un relâchement de touche qui
    /// n'existe pas ne doit rien couper avant l'heure.
    pub fn release(&self) {
        if let Some(a) = self.active.lock().unwrap().as_mut() {
            if a.hold {
                a.released_at.get_or_insert(Instant::now());
            }
        }
    }

    pub fn clear(&self) {
        *self.active.lock().unwrap() = None;
    }

    /// Composite sur `frame` (BGR24, `width`×`height`) si un meme est actif.
    /// Appelé depuis le thread de pompage, une fois par image caméra.
    pub fn composite(&self, frame: &mut [u8], width: u32, height: u32) {
        let mut guard = self.active.lock().unwrap();
        let Some(ov) = guard.as_mut() else { return };

        let now = Instant::now();
        let opacity = if let Some(rel) = ov.released_at {
            let since = now.duration_since(rel).as_millis() as u64;
            if since >= EXIT_MS {
                *guard = None;
                return;
            }
            1.0 - (since as f64 / EXIT_MS as f64)
        } else {
            let age = now.duration_since(ov.started_at).as_millis() as u64;
            if !ov.hold && age >= ov.duration_ms {
                ov.released_at = Some(now);
                1.0
            } else if age < ov.enter_ms {
                age as f64 / ov.enter_ms.max(1) as f64
            } else {
                1.0
            }
        };

        let (asset_id, asset_path) = (ov.asset_id.clone(), ov.asset_path.clone());
        let (x, y, size) = (ov.x_pct, ov.y_pct, ov.size_pct);
        drop(guard); // decode() reprend son propre verrou sur `cache`

        if let Some(img) = self.decode(&asset_id, &asset_path) {
            blend(frame, width, height, &img, x, y, size, opacity);
        }
    }

    fn decode(&self, asset_id: &str, path: &PathBuf) -> Option<RgbaImage> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(img) = cache.get(asset_id) {
            return Some(img.clone());
        }
        let img = image::open(path).ok()?.to_rgba8();
        cache.insert(asset_id.to_string(), img.clone());
        Some(img)
    }
}

/// Alpha-blend au plus proche voisin : le coût suit la taille du MEME, pas de
/// la caméra — négligeable face au reste de la boucle de pompage. Pas de
/// filtrage bilinéaire, inutile à l'échelle d'un meme et payé 30 fois/seconde.
fn blend(
    frame: &mut [u8],
    fw: u32,
    fh: u32,
    img: &RgbaImage,
    x_pct: f64,
    y_pct: f64,
    size_pct: f64,
    opacity: f64,
) {
    if opacity <= 0.0 || img.width() == 0 || img.height() == 0 {
        return;
    }
    let target_w = (((fw as f64) * (size_pct / 100.0)).round().max(1.0)) as u32;
    let scale = target_w as f64 / img.width() as f64;
    let target_h = ((img.height() as f64 * scale).round().max(1.0)) as u32;
    let ox = (((fw as f64) * (x_pct / 100.0)) - target_w as f64 / 2.0).round() as i64;
    let oy = (((fh as f64) * (y_pct / 100.0)) - target_h as f64 / 2.0).round() as i64;

    for ty in 0..target_h {
        let fy = oy + ty as i64;
        if fy < 0 || fy >= fh as i64 {
            continue;
        }
        let sy = ((ty as u64 * img.height() as u64) / target_h as u64).min(img.height() as u64 - 1) as u32;
        let row = (fy as u32 * fw) as usize;
        for tx in 0..target_w {
            let fx = ox + tx as i64;
            if fx < 0 || fx >= fw as i64 {
                continue;
            }
            let sx = ((tx as u64 * img.width() as u64) / target_w as u64).min(img.width() as u64 - 1) as u32;
            let p = img.get_pixel(sx, sy);
            let a = (p[3] as f64 / 255.0) * opacity;
            if a <= 0.0 {
                continue;
            }
            let idx = (row + fx as usize) * 3;
            if idx + 2 >= frame.len() {
                continue;
            }
            // Trame caméra en BGR, image décodée en RGBA — l'ordre s'inverse ici.
            frame[idx] = lerp(frame[idx], p[2], a);
            frame[idx + 1] = lerp(frame[idx + 1], p[1], a);
            frame[idx + 2] = lerp(frame[idx + 2], p[0], a);
        }
    }
}

fn lerp(bg: u8, fg: u8, a: f64) -> u8 {
    (bg as f64 * (1.0 - a) + fg as f64 * a).round() as u8
}
