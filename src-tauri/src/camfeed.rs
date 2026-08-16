//! Livraison directe des images de la caméra virtuelle à la webview.
//!
//! ─── Pourquoi ce chemin existe ──────────────────────────────────────────────
//! Quand la caméra virtuelle tourne, la webcam physique est en accès exclusif :
//! la pompe la tient, et la détection ne peut plus l'ouvrir. Elle consommait
//! donc « deck4me Camera » comme n'importe quelle autre webcam.
//!
//! Mesuré : la pompe publiait 17 images par seconde, la détection en recevait
//! 8. WebView2 copie chaque image (2,7 Mo en RGB24 720p), la convertit à son
//! format interne, et rate la suivante pendant ce temps. Une sur deux, parfois
//! une sur trois.
//!
//! Le détour était absurde : Rust tient déjà l'image en mémoire, l'envoie à
//! Windows, qui la rend à un navigateur logé dans le même processus.
//!
//! ─── Ce que fait ce module ──────────────────────────────────────────────────
//! Il réduit l'image à une définition modeste, l'encode en JPEG, et la pousse
//! sur le serveur local déjà présent. Streamlabs continue de recevoir sa caméra virtuelle en pleine
//! définition : les deux chemins sont indépendants.
//!
//! Six fois moins d'octets, aucune conversion imposée, et surtout plus aucune
//! dépendance à la vitesse à laquelle WebView2 veut bien consommer DirectShow.
use std::sync::{Arc, OnceLock};
use tokio::sync::broadcast;

/// Côté long livré à la webview.
///
/// La DÉTECTION n'a besoin que de 640 : MediaPipe redimensionne lui-même en
/// interne autour de 200 px, et monter plus haut ne change pas un landmark.
/// C'est l'APERÇU qui réclame davantage — depuis le court-circuit, il n'affiche
/// plus le flux de la webcam mais cette image-là, et 640 le rendait mou.
///
/// 960 plutôt que 1280 : le coût d'encodage et de décodage suit le nombre de
/// pixels, pas le côté. 960×540 fait 2,2 fois 640×360 ; 1280×720 en ferait 4.
/// Sur une pompe qui tient 51 ms par image, ces millisecondes se paient en
/// cadence, des deux côtés — Rust encode, la webview décode, et ce décodage-là
/// tombe dans le budget de la détection.
///
/// Un cran plus haut reste possible en changeant ce seul nombre, si l'aperçu
/// prime sur les images par seconde.
const LONG_SIDE: u32 = 960;

/// Qualité JPEG. 70 est le point où l'artefact devient invisible sur un visage
/// à cette taille ; monter coûte des octets sans rien rendre aux landmarks.
const QUALITY: u8 = 70;

/// Un abonné lent ne doit pas retarder la pompe : au-delà de cette réserve, les
/// images les plus vieilles sont abandonnées. Perdre une image de détection est
/// sans conséquence, prendre du retard en accumule.
const BACKLOG: usize = 2;

type Frame = Arc<Vec<u8>>;

fn channel() -> &'static broadcast::Sender<Frame> {
    static TX: OnceLock<broadcast::Sender<Frame>> = OnceLock::new();
    TX.get_or_init(|| broadcast::channel(BACKLOG).0)
}

pub fn subscribe() -> broadcast::Receiver<Frame> {
    channel().subscribe()
}

/// Y a-t-il quelqu'un à servir ? La pompe interroge ceci AVANT de réduire et
/// d'encoder : sans abonné, ce travail est intégralement perdu.
pub fn wanted() -> bool {
    channel().receiver_count() > 0
}

/// Facteur de réduction entier, ou 1. Les définitions réelles tombent juste —
/// 1280×720 et 2560×1440 donnent 2 et 4 — et un facteur entier permet une
/// moyenne de blocs, qui coûte une addition par pixel source.
fn factor(w: u32, h: u32) -> u32 {
    let long = w.max(h);
    if long <= LONG_SIDE {
        return 1;
    }
    (long / LONG_SIDE).max(1)
}

/// Réduit du RGB en place vers un tampon réutilisé, par moyenne de blocs.
///
/// Moyenne et non prélèvement : le sous-échantillonnage brut crée du crénelage
/// sur les contours du visage, et les landmarks se calent précisément sur ces
/// contours-là.
fn shrink(src: &[u8], w: u32, h: u32, f: u32, out: &mut Vec<u8>) -> (u32, u32) {
    let (dw, dh) = (w / f, h / f);
    out.clear();
    out.resize((dw * dh * 3) as usize, 0);
    let n = (f * f) as u32;
    for y in 0..dh {
        for x in 0..dw {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for dy in 0..f {
                let row = ((y * f + dy) * w) as usize * 3;
                for dx in 0..f {
                    let i = row + ((x * f + dx) as usize) * 3;
                    r += src[i] as u32;
                    g += src[i + 1] as u32;
                    b += src[i + 2] as u32;
                }
            }
            let o = ((y * dw + x) * 3) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    (dw, dh)
}

/// Réduit, encode et publie. Appelé depuis le fil de la pompe.
///
/// Les tampons sont fournis par l'appelant et réutilisés : allouer deux fois
/// par image, trente fois par seconde, occupe le processeur à gérer de la
/// mémoire plutôt qu'à traiter des images.
pub fn publish(rgb: &[u8], w: u32, h: u32, small: &mut Vec<u8>, jpeg: &mut Vec<u8>) {
    if !wanted() {
        return;
    }
    let f = factor(w, h);
    let (dw, dh) = if f > 1 {
        shrink(rgb, w, h, f, small)
    } else {
        small.clear();
        small.extend_from_slice(rgb);
        (w, h)
    };

    jpeg.clear();
    let enc = jpeg_encoder::Encoder::new(&mut *jpeg, QUALITY);
    if enc
        .encode(small, dw as u16, dh as u16, jpeg_encoder::ColorType::Rgb)
        .is_err()
    {
        return;
    }
    // `send` échoue quand plus personne n'écoute : ce n'est pas une erreur,
    // c'est l'état normal dès que la détection se ferme.
    let _ = channel().send(Arc::new(std::mem::take(jpeg)));
}
