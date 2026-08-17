//! Sonde temporaire : un second hook clavier, copie conforme du bac d'essai.
//!
//! ─── Pourquoi elle existe ───────────────────────────────────────────────────
//! Un programme isolé, écrit avec exactement le même montage (fil dédié, boucle
//! `GetMessageW`, `hmod` du module) et compilé avec exactement le même profil
//! release, capture cent cinquante-huit frappes en une minute sur cette
//! machine. Le même montage dans deck4me en capture zéro.
//!
//! Deux explications restent, et on ne peut pas les départager de l'extérieur :
//! soit `deckhook` a un défaut que le bac d'essai n'a pas, soit c'est le
//! PROCESSUS deck4me qui ne reçoit rien. Cette sonde tranche : elle vit dans le
//! même processus, ne partage pas une ligne avec `deckhook`, et ne fait rien
//! d'autre que compter.
//!
//! Elle n'avale aucune touche et ne déclenche rien. À retirer dès que la
//! question est tranchée — elle n'a aucune raison d'exister ensuite.

use std::sync::atomic::{AtomicU32, Ordering};

const WH_KEYBOARD_LL: i32 = 13;
type Proc = unsafe extern "system" fn(i32, usize, isize) -> isize;

#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    x: i32,
    y: i32,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(n: *const u16) -> isize;
}

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id: i32, f: Proc, m: isize, t: u32) -> isize;
    fn CallNextHookEx(h: isize, c: i32, w: usize, l: isize) -> isize;
    fn GetMessageW(m: *mut Msg, h: isize, a: u32, b: u32) -> i32;
}

static COUNT: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn probe(code: i32, w: usize, l: isize) -> isize {
    if code == 0 {
        COUNT.fetch_add(1, Ordering::Relaxed);
    }
    CallNextHookEx(0, code, w, l)
}

pub fn start() {
    std::thread::spawn(|| unsafe {
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, probe, GetModuleHandleW(std::ptr::null()), 0);
        crate::diag::log("sonde", &format!("second hook posé → {h:#x}"));
        if h == 0 {
            return;
        }
        std::thread::spawn(|| {
            let mut last = u32::MAX;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(3000));
                let n = COUNT.load(Ordering::Relaxed);
                if n != last {
                    last = n;
                    crate::diag::log("sonde", &format!("{n} touche(s) vue(s)"));
                }
            }
        });
        let mut msg: Msg = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {}
    });
}
