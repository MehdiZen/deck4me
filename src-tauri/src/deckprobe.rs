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
    fn GetCurrentProcess() -> isize;
    fn IsProcessInJob(process: isize, job: isize, result: *mut i32) -> i32;
    fn QueryInformationJobObject(
        job: isize,
        class: i32,
        info: *mut core::ffi::c_void,
        len: u32,
        ret: *mut u32,
    ) -> i32;
    fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
    fn GetTokenInformation(
        token: isize,
        class: i32,
        info: *mut core::ffi::c_void,
        len: u32,
        ret: *mut u32,
    ) -> i32;
    fn CloseHandle(h: isize) -> i32;
}

/// Ce que Windows dit du processus lui-même.
///
/// Un job assorti de restrictions d'interface empêche les hooks de voir ce qui
/// se passe HORS du job : le hook s'installe, renvoie un handle valide, et ne
/// reçoit que les événements destinés au job. C'est exactement ce qu'on
/// observe — les seules touches jamais captées l'ont été pendant que
/// l'application avait le focus.
///
/// Un niveau d'intégrité inférieur à celui des fenêtres visées produit le même
/// silence, pour une autre raison. Les deux se lisent ici.
fn describe_process() {
    unsafe {
        let me = GetCurrentProcess();

        let mut in_job: i32 = 0;
        IsProcessInJob(me, 0, &mut in_job);

        // JOBOBJECT_BASIC_UI_RESTRICTIONS : un seul u32 de drapeaux.
        let mut ui: u32 = 0;
        let mut ret: u32 = 0;
        let got = QueryInformationJobObject(
            0,
            4, // JobObjectBasicUIRestrictions
            &mut ui as *mut u32 as *mut core::ffi::c_void,
            4,
            &mut ret,
        );

        // Niveau d'intégrité du jeton : la valeur brute suffit à comparer.
        let mut level = 0u32;
        let mut token: isize = 0;
        if OpenProcessToken(me, 0x0008 /* TOKEN_QUERY */, &mut token) != 0 {
            let mut buf = [0u8; 64];
            let mut n = 0u32;
            if GetTokenInformation(
                token,
                25, // TokenIntegrityLevel
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut n,
            ) != 0
            {
                // TOKEN_MANDATORY_LABEL : un SID dont le dernier sous-autorité
                // porte le niveau (0x2000 moyen, 0x3000 élevé).
                let sid = *(buf.as_ptr() as *const *const u8);
                if !sid.is_null() {
                    let count = *sid.add(1) as usize;
                    let sub = sid.add(8) as *const u32;
                    if count > 0 {
                        level = *sub.add(count - 1);
                    }
                }
            }
            CloseHandle(token);
        }

        crate::diag::log(
            "sonde",
            &format!(
                "processus : dans un job = {}, restrictions d'interface = {} (lu : {}), intégrité = 0x{:X}",
                in_job != 0,
                ui,
                got != 0,
                level
            ),
        );
    }
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
    describe_process();
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
