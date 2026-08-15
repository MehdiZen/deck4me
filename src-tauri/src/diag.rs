//! Journal de fonctionnement.
//!
//! Une application Windows sans console n'a AUCUNE sortie d'erreur : les
//! `eprintln!` du code partaient dans le vide. Quand quelque chose casse au
//! milieu d'un live, il faut pouvoir regarder après coup — sinon il ne reste
//! que « ça a planté » et rien à en tirer.
//!
//! Le profil release compile en `panic = "abort"` : un panic tue le processus
//! sans dérouler la pile et sans afficher quoi que ce soit. Le crochet posé
//! ici est la seule trace qu'il en restera.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

/// Au-delà, on repart d'un fichier neuf. Un journal qui grossit sans fin
/// finit par être le problème qu'il devait aider à diagnostiquer.
const MAX_BYTES: u64 = 1_000_000;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn init(dir: &Path) {
    let path = dir.join("meme4me.log");
    // Rotation à l'ouverture plutôt qu'à chaque écriture : une seule
    // interrogation du système de fichiers par lancement.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = std::fs::rename(&path, dir.join("meme4me.log.1"));
        }
    }
    let _ = LOG_PATH.set(path);
    log("démarrage", &format!("meme4me {}", env!("CARGO_PKG_VERSION")));

    std::panic::set_hook(Box::new(|info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".into());
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panique sans message".into());
        log("PANIQUE", &format!("{what} — à {where_}"));
    }));
}

/// Horodatage local sans dépendance : on ne date pas au millionième, on veut
/// juste pouvoir recouper avec « il était environ 21 h quand ça a lâché ».
fn stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (h, m, s) = ((now / 3600) % 24, (now / 60) % 60, now % 60);
    format!("{h:02}:{m:02}:{s:02}Z")
}

pub fn log(kind: &str, msg: &str) {
    let Some(path) = LOG_PATH.get() else {
        return; // journal pas encore ouvert : rien à faire, surtout pas paniquer
    };
    let line = format!("{} [{}] {}\n", stamp(), kind, msg);
    let _guard = WRITE_LOCK.lock();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn path() -> Option<String> {
    LOG_PATH.get().map(|p| p.display().to_string())
}
