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
const WM_QUIT: u32 = 0x0012;
const WM_KEYDOWN: usize = 0x0100;
const WM_KEYUP: usize = 0x0101;
const WM_SYSKEYDOWN: usize = 0x0104;
const WM_SYSKEYUP: usize = 0x0105;
const LLKHF_EXTENDED: u32 = 0x01;

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
    fn GetCurrentThreadId() -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id: i32, f: HookProc, module: isize, thread: u32) -> isize;
    fn UnhookWindowsHookEx(h: isize) -> i32;
    fn CallNextHookEx(h: isize, code: i32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
    fn PostThreadMessageW(thread: u32, msg: u32, w: usize, l: isize) -> i32;
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
/// Identifiant du fil qui sert le hook, pour pouvoir lui demander de s'arrêter.
static THREAD: AtomicU32 = AtomicU32::new(0);
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

/// Pose le hook. À appeler depuis le fil qui le servira.
fn install() -> bool {
    let h =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, hook_proc, GetModuleHandleW(std::ptr::null()), 0) };
    if h == 0 {
        return false;
    }
    // Remplacer un hook existant sans laisser le précédent derrière.
    let old = HOOK.swap(h, Ordering::SeqCst);
    if old != 0 {
        unsafe { UnhookWindowsHookEx(old) };
    }
    true
}

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

/// Installe le hook sur un fil qui ne fait QUE le servir. Idempotent.
///
/// ─── Pourquoi ce fil, et pas le fil principal ───────────────────────────────
/// Un hook bas niveau n'est servi que par un fil qui pompe des messages. Tauri
/// en a déjà un sur le fil principal, et une version l'y a posé — mais ce
/// fil-là monte deux webviews au démarrage et fait vivre toute l'interface
/// ensuite. Or Windows retire SILENCIEUSEMENT un hook dont le rappel n'a pas
/// répondu en 300 ms. Mesuré sur cette configuration : quatre événements reçus
/// en une session entière, tous pendant que l'application avait le focus.
///
/// Un fil dédié ne fait rien d'autre qu'attendre dans `GetMessageW`. Il ne peut
/// pas être en retard, donc le hook ne peut pas être jeté pour retard.
///
/// ─── Pourquoi j'y reviens ───────────────────────────────────────────────────
/// C'était le montage d'origine, abandonné sur une fausse preuve : deux
/// sessions à zéro événement, interprétées comme « ce fil ne reçoit rien »
/// alors qu'aucune touche n'avait été frappée pendant qu'il écoutait. Un bac
/// d'essai isolé — même montage, même profil de compilation release, même
/// machine — capture cent cinquante-huit événements en une minute, dans
/// n'importe quelle application. Le fil dédié n'a jamais été le problème.
pub fn start(_app: &AppHandle, on_event: impl Fn(Event) + Send + 'static) {
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
    std::thread::spawn(|| unsafe {
        if !install() {
            crate::diag::log("deck", "hook clavier refusé par Windows");
            STARTING.store(false, Ordering::SeqCst);
            return;
        }
        THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        STARTING.store(false, Ordering::SeqCst);
        crate::diag::log("deck", "hook clavier installé (fil dédié)");
        watchdog();
        // Ce fil n'existe que pour cette boucle. C'est elle que Windows
        // interrompt pour appeler le rappel.
        let mut msg: Msg = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {}
        let h = HOOK.swap(0, Ordering::SeqCst);
        if h != 0 {
            UnhookWindowsHookEx(h);
        }
        THREAD.store(0, Ordering::SeqCst);
        crate::diag::log(
            "deck",
            &format!(
                "hook clavier retiré — {} événement(s) vus",
                SEEN.load(Ordering::Relaxed)
            ),
        );
    });
}

/// Demande au fil du hook de s'arrêter.
pub fn stop() {
    let t = THREAD.load(Ordering::SeqCst);
    if t == 0 {
        return;
    }
    unsafe { PostThreadMessageW(t, WM_QUIT, 0, 0) };
    // On attend qu'il ait vraiment rendu la main : `stop` est suivi d'un
    // réarmement possible, et repartir trop tôt trouve un hook encore vivant.
    for _ in 0..100 {
        if !running() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
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
