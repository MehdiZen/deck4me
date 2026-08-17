//! Branchement Windows du deck : le hook clavier bas niveau et le rejeu.
//!
//! Séparé de `deck` à dessein — là-bas c'est une machine à états pure, qu'on
//! teste sans clavier ni système ; ici c'est l'appel système, qu'on ne teste
//! pas. Tout ce que ce module décide, il le décide en déléguant.
//!
//! ─── Deux règles qui ne se négocient pas ────────────────────────────────────
//!
//! 1. **Le rappel ne bloque JAMAIS.** Windows appelle ce code sur le fil qui
//!    traite les entrées de toute la session. Y attendre un verrou, écrire un
//!    fichier ou parler à la webview ferait ramer le clavier de la machine
//!    entière — et Windows finirait par désinstaller le hook sans prévenir.
//!    D'où le `try_lock` : en cas de contention on laisse passer la touche.
//!    Rater une case vaut infiniment mieux que figer le clavier.
//!
//! 2. **Aucune ligne ne doit pouvoir paniquer.** Le profil de release porte
//!    `panic = "abort"` : une panique ici ne remonterait pas, elle tuerait le
//!    processus. Pas d'indexation, pas d'`unwrap`.
//!
//! ─── Les événements injectés sont ignorés ───────────────────────────────────
//! `actions.rs` sait envoyer des frappes (le type d'action « raccourci
//! clavier »), et ce module en envoie lui-même pour le rejeu. Sans le filtre
//! `INJECTED`, une case qui envoie `Alt+F1` se redéclencherait elle-même — une
//! boucle infinie à la vitesse du processeur.

use crate::deck::{Config, Deck, Event, Verdict, E};
use tauri::AppHandle;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

// ---- FFI ----------------------------------------------------------------
//
// Déclarée à la main plutôt que par la caisse `windows` : six fonctions et
// trois structures contre une dépendance qui rallongerait chaque compilation,
// sur un projet déjà en `lto = true` et `codegen-units = 1`. Le reste du Rust
// de ce dépôt fait le même choix (`libloading`, `winreg`).

const WH_KEYBOARD_LL: i32 = 13;
const HC_ACTION: i32 = 0;
const WM_KEYDOWN: usize = 0x0100;
const WM_KEYUP: usize = 0x0101;
const WM_SYSKEYDOWN: usize = 0x0104;
const WM_SYSKEYUP: usize = 0x0105;
const LLKHF_EXTENDED: u32 = 0x01;
#[repr(C)]
struct KbdLlHook {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    extra: usize,
}

type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id: i32, f: HookProc, module: isize, thread: u32) -> isize;
    fn UnhookWindowsHookEx(h: isize) -> i32;
    fn CallNextHookEx(h: isize, code: i32, w: usize, l: isize) -> isize;
}

// ---- État global --------------------------------------------------------

fn deck() -> &'static Mutex<Deck> {
    static D: OnceLock<Mutex<Deck>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(Deck::default()))
}

/// Fil de sortie. Le rappel y dépose et repart : tout ce qui prend du temps
/// (déclencher une chaîne d'actions, réveiller le widget) se passe ailleurs.
fn sink() -> &'static Mutex<Option<Sender<Event>>> {
    static S: OnceLock<Mutex<Option<Sender<Event>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

static HOOK: AtomicIsize = AtomicIsize::new(0);
/// Combien d'événements le rappel a-t-il vus ? Sert à ne tracer que les
/// premiers : « le hook est installé » et « le hook reçoit » sont deux états
/// distincts, et rien d'autre ne les sépare.
static SEEN: AtomicU32 = AtomicU32::new(0);
/// Un démarrage est en cours. `HOOK` n'est posé que DANS le fil du hook, donc
/// `running()` reste faux le temps qu'il démarre : deux appels rapprochés à
/// `start` — et il y en a, au démarrage puis à chaque enregistrement de case —
/// installaient deux hooks et deux puits concurrents.
static STARTING: AtomicBool = AtomicBool::new(false);
const RING_LEN: usize = 16;
/// Les seize dernières touches vues, chacune repliée en un entier
/// (vk, scancode, drapeaux). Écrit par le rappel, lu par le fil de veille.
static RING: [AtomicU32; RING_LEN] = [const { AtomicU32::new(0) }; RING_LEN];

/// Fil de veille : dit périodiquement combien d'événements le rappel a vus.
///
/// Il existe parce que le rappel ne peut RIEN écrire lui-même sans risquer le
/// délai de 300 ms au-delà duquel Windows retire le hook en silence. Séparer
/// « compter » de « raconter » est la seule façon d'observer ce chemin sans le
/// casser en l'observant.
fn watchdog() {
    std::thread::spawn(|| {
        let mut last = u32::MAX;
        while running() {
            let n = SEEN.load(Ordering::Relaxed);
            if n != last {
                let first = last.min(n).max(n.saturating_sub(RING_LEN as u32));
                let mut trace = String::new();
                for i in first..n {
                    let d = RING[(i as usize) % RING_LEN].load(Ordering::Relaxed);
                    // « ↓ » appui, « ↑ » relâchement : le drapeau 0x80 le porte.
                    let sens = if d & 0x80 != 0 { '↑' } else { '↓' };
                    trace.push_str(&format!(
                        " {sens}vk{:02X}/sc{:02X}",
                        (d >> 16) & 0xFF,
                        (d >> 8) & 0xFF
                    ));
                }
                last = n;
                crate::diag::log("deck", &format!("{n} événement(s) —{trace}"));
            }
            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
    });
}

/// Remplace la configuration du deck. Sans effet sur le hook lui-même : on
/// peut reconfigurer les cases pendant qu'il tourne.
pub fn configure(cfg: Config) {
    let empty = cfg.pages.is_empty();
    if let Ok(mut d) = deck().lock() {
        *d = Deck::new(cfg);
    }
    // Aucune touche de page : le hook n'a plus rien à observer. Le désinstaller
    // plutôt que le laisser tourner à vide — le meilleur moyen de ne pas
    // gêner le clavier de quelqu'un, c'est de ne pas y être.
    if empty {
        stop();
    }
}

pub fn running() -> bool {
    HOOK.load(Ordering::Relaxed) != 0
}

/// Installe le hook SUR LE FIL PRINCIPAL. Idempotent.
///
/// ─── Pourquoi pas sur un fil à nous ─────────────────────────────────────────
/// Un hook bas niveau n'est servi que par un fil qui pompe des messages, et la
/// première version en créait donc un, avec sa propre boucle `GetMessageW`.
/// Cette boucle fonctionnait — elle recevait bien l'ordre d'arrêt — mais le
/// rappel n'a JAMAIS été appelé une seule fois : compteur atomique à zéro après
/// vingt-six secondes, touches enfoncées. Le même code, dans un programme isolé,
/// reçoit tout.
///
/// Tauri fait déjà tourner une boucle de messages sur le fil principal. On y
/// pose le hook plutôt que d'en entretenir une seconde : moins de code, et une
/// boucle dont on sait qu'elle est vivante puisque c'est elle qui fait vivre
/// toute l'interface.
///
/// Le rappel n'y coûte rien — un incrément atomique et un envoi sur un canal —
/// ce que la règle « ne jamais bloquer » imposait déjà de toute façon.
pub fn start(app: &AppHandle, on_event: impl Fn(Event) + Send + 'static) {
    if running() || STARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = mpsc::channel::<Event>();
    if let Ok(mut s) = sink().lock() {
        *s = Some(tx);
    }
    std::thread::spawn(move || {
        for ev in rx {
            on_event(ev);
        }
    });
    let _ = app.run_on_main_thread(|| unsafe {
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, hook_proc, GetModuleHandleW(std::ptr::null()), 0);
        STARTING.store(false, Ordering::SeqCst);
        if h == 0 {
            crate::diag::log("deck", "hook clavier refusé par Windows");
            return;
        }
        HOOK.store(h, Ordering::SeqCst);
        crate::diag::log("deck", "hook clavier installé (fil principal)");
        watchdog();
    });
}

/// Désinstalle le hook.
///
/// `UnhookWindowsHookEx` s'appelle depuis n'importe quel fil, et c'est heureux :
/// l'un des appelants est la fermeture de la fenêtre, d'où l'on ne peut plus
/// compter sur la boucle principale pour exécuter quoi que ce soit.
pub fn stop() {
    let h = HOOK.swap(0, Ordering::SeqCst);
    if h == 0 {
        return;
    }
    unsafe { UnhookWindowsHookEx(h) };
    crate::diag::log(
        "deck",
        &format!(
            "hook clavier retiré — {} événement(s) vus",
            SEEN.load(Ordering::Relaxed)
        ),
    );
}

// ---- Le rappel ----------------------------------------------------------

unsafe extern "system" fn hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    let next = |h: isize| CallNextHookEx(h, code, wparam, lparam);
    if code != HC_ACTION || lparam == 0 {
        return next(0);
    }
    let info = &*(lparam as *const KbdLlHook);

    // Compteur atomique, et RIEN d'autre : pas d'allocation, pas de fichier, pas
    // de verrou. La trace précédente écrivait dans le journal depuis ici, et son
    // absence a été lue comme « le rappel n'est jamais appelé » — alors qu'elle
    // prouvait seulement que la ligne ne s'écrivait pas. Deux affirmations très
    // différentes, et j'ai perdu deux builds à confondre les deux.
    //
    // Un incrément atomique ne peut pas échouer, ne peut pas bloquer, et ne peut
    // pas dépasser le budget de 300 ms au-delà duquel Windows retire un hook
    // sans prévenir. Le fil de veille, lui, a tout loisir d'écrire.
    let n = SEEN.fetch_add(1, Ordering::Relaxed);
    // Journal circulaire des dernières touches vues, replié un entier par
    // case. Le simple « dernier événement » ne suffisait pas : il faut savoir
    // quels codes physiques envoie RÉELLEMENT ce pavé numérique, et la dernière
    // touche d'une séquence est justement celle qui n'apprend rien.
    RING[(n as usize) % RING_LEN].store(
        ((info.vk_code & 0xFF) << 16) | ((info.scan_code & 0xFF) << 8) | (info.flags & 0xFF),
        Ordering::Relaxed,
    );

    // On n'ignore QUE ce que nous avons envoyé nous-mêmes, reconnu à sa marque.
    //
    // Le filtre précédent portait sur le drapeau « injecté » de Windows, ce qui
    // était trop large : les logiciels de clavier des fabricants (iCUE, Synapse,
    // G HUB) réinjectent chaque frappe, et sur une machine équipée de l'un
    // d'eux le deck ignorait la totalité du clavier.
    if info.extra == crate::actions::sys::TAG {
        return next(0);
    }
    let down = wparam == WM_KEYDOWN || wparam == WM_SYSKEYDOWN;
    if !down && wparam != WM_KEYUP && wparam != WM_SYSKEYUP {
        return next(0);
    }
    let key = (info.scan_code & 0xFF) | if info.flags & LLKHF_EXTENDED != 0 { E } else { 0 };

    // `try_lock` et non `lock` : voir l'en-tête. Une touche perdue est un
    // désagrément, un clavier figé est une panne.
    let Ok(mut d) = deck().try_lock() else {
        return next(0);
    };
    let (verdict, events) = d.key(key, down);
    drop(d);

    if !events.is_empty() {
        if let Ok(s) = sink().lock() {
            if let Some(tx) = s.as_ref() {
                for ev in events {
                    let _ = tx.send(ev);
                }
            }
        }
    }

    match verdict {
        Verdict::Pass => next(0),
        Verdict::Swallow => 1,
        Verdict::SwallowAndTap(sc) => {
            send_key(sc, true);
            send_key(sc, false);
            1
        }
        Verdict::ReplayDownThenPass(sc) => {
            // L'appui rendu au système entre dans la file d'entrée maintenant,
            // alors que la touche courante est encore en train de traverser la
            // chaîne de hooks : elle arrivera donc après. C'est ce qui garde
            // Alt+Tab dans le bon ordre.
            send_key(sc, true);
            next(0)
        }
    }
}

/// Envoie une touche par son code physique, en passant par l'envoi clavier
/// déjà présent dans `actions` — celui-là a sa propre vérification de taille de
/// `INPUT` à la compilation. Deux déclarations concurrentes du même symbole
/// système marchent jusqu'au jour où l'une des deux change.
fn send_key(key: u32, down: bool) {
    crate::actions::sys::send_scan((key & 0xFF) as u16, key & E != 0, down);
}
