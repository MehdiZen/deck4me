//! Vérifie le pont FFI vers softcam sans webcam ni élévation UAC.
//! C'est là que se cachent les bugs silencieux (symbole mal nommé, convention
//! d'appel, taille de buffer) : un mauvais prototype corrompt la mémoire au
//! lieu d'échouer proprement.

use facememe_lib::virtualcam::{VirtualCam, FILTER_CLSID};
use std::ffi::c_void;
use std::path::PathBuf;

fn dll_path() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../vendor/softcam/dist/bin/x64/softcam.dll"
    ))
}

#[test]
fn softcam_dll_is_vendored_and_exports_sender_api() {
    let path = dll_path();
    assert!(path.exists(), "softcam.dll absent — construire vendor/softcam");

    type Create = unsafe extern "C" fn(i32, i32, f32) -> *mut c_void;
    type Delete = unsafe extern "C" fn(*mut c_void);
    type Send = unsafe extern "C" fn(*mut c_void, *const c_void);
    type Connected = unsafe extern "C" fn(*mut c_void) -> bool;

    unsafe {
        let lib = libloading::Library::new(&path).expect("chargement DLL");
        let create: libloading::Symbol<Create> = lib.get(b"scCreateCamera").expect("scCreateCamera");
        let delete: libloading::Symbol<Delete> = lib.get(b"scDeleteCamera").expect("scDeleteCamera");
        let send: libloading::Symbol<Send> = lib.get(b"scSendFrame").expect("scSendFrame");
        let connected: libloading::Symbol<Connected> =
            lib.get(b"scIsConnected").expect("scIsConnected");

        // 640x480 (multiples de 4 exigés), framerate 0 = temps réel
        let cam = create(640, 480, 0.0);
        assert!(!cam.is_null(), "création de la caméra virtuelle refusée");

        // Un buffer BGR complet : si le prototype était faux, on corromprait
        // la mémoire partagée ici.
        let frame = vec![0u8; 640 * 480 * 3];
        send(cam, frame.as_ptr() as *const c_void);
        assert!(!connected(cam), "aucun consommateur ne doit être connecté");

        delete(cam);
    }
}

#[test]
fn clsid_matches_the_vendored_filter() {
    // Le CLSID sert à détecter l'installation ; s'il diverge du filtre
    // construit, l'UI dirait « non installé » pour toujours.
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../vendor/softcam/src/softcam/softcam.cpp"
    ))
    .expect("source softcam");
    assert!(
        src.contains("0xaef3b972, 0x5fa5, 0x4647, 0x95, 0x71, 0x35, 0x8e, 0xb4, 0x72, 0xbc, 0x9e"),
        "le CLSID du filtre a changé, mettre à jour FILTER_CLSID ({FILTER_CLSID})"
    );
    // et le filtre doit bien s'annoncer sous notre nom
    assert!(
        src.contains(r#"L"facememe Camera""#),
        "le FriendlyName du filtre doit être « facememe Camera »"
    );
}

#[test]
fn device_enumeration_excludes_our_own_virtual_camera() {
    // Se recapturer soi-même créerait une boucle infinie.
    let devices = VirtualCam::devices();
    assert!(
        devices.iter().all(|d| !d.name.contains("facememe")),
        "la caméra virtuelle facememe ne doit jamais être proposée comme source"
    );
}
