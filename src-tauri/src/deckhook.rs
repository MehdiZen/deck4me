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
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
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
const WM_QUIT: u32 = 0x0012;
const LLKHF_EXTENDED: u32 = 0x01;
const LLKHF_INJECTED: u32 = 0x10;
#[repr(C)]
struct KbdLlHook {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    extra: usize,
}

#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
}

type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id: i32, f: HookProc, module: isize, thread: u32) -> isize;
    fn UnhookWindowsHookEx(h: isize) -> i32;
    fn CallNextHookEx(h: isize, code: i32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
    fn PostThreadMessageW(thread: u32, msg: u32, w: usize, l: isize) -> i32;
    fn GetCurrentThreadId() -> u32;
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
static THREAD: AtomicU32 = AtomicU32::new(0);

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

/// Installe le hook sur son propre fil. Idempotent.
pub fn start(on_event: impl Fn(Event) + Send + 'static) {
    if running() {
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
    std::thread::spawn(|| unsafe {
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, hook_proc, 0, 0);
        if h == 0 {
            crate::diag::log("deck", "hook clavier refusé par Windows");
            return;
        }
        HOOK.store(h, Ordering::SeqCst);
        THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        // Un hook bas niveau n'existe que sur un fil qui pompe des messages :
        // c'est cette boucle que Windows utilise pour livrer les touches.
        let mut msg: Msg = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {}
        UnhookWindowsHookEx(h);
        HOOK.store(0, Ordering::SeqCst);
        THREAD.store(0, Ordering::SeqCst);
    });
}

pub fn stop() {
    let t = THREAD.load(Ordering::SeqCst);
    if t != 0 {
        unsafe { PostThreadMessageW(t, WM_QUIT, 0, 0) };
    }
}

// ---- Le rappel ----------------------------------------------------------

unsafe extern "system" fn hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    let next = |h: isize| CallNextHookEx(h, code, wparam, lparam);
    if code != HC_ACTION || lparam == 0 {
        return next(0);
    }
    let info = &*(lparam as *const KbdLlHook);
    if info.flags & LLKHF_INJECTED != 0 {
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
