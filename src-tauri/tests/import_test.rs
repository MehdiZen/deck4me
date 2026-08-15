//! Reconnaissance des formats et garde-fous de l'import par URL.

use meme4me_lib::store::{is_audio, is_opaque, sniff};

fn ftyp(brand: &[u8; 4]) -> Vec<u8> {
    let mut v = vec![0, 0, 0, 0x20];
    v.extend_from_slice(b"ftyp");
    v.extend_from_slice(brand);
    v.extend_from_slice(&[0u8; 8]);
    v
}

#[test]
fn reconnait_les_images() {
    assert_eq!(sniff(b"\x89PNG\r\n\x1a\n").unwrap(), ("image/png", "png"));
    assert_eq!(sniff(b"GIF89a....").unwrap(), ("image/gif", "gif"));
    assert_eq!(sniff(b"\xff\xd8\xff\xe0JFIF").unwrap(), ("image/jpeg", "jpg"));
    assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 ").unwrap(), ("image/webp", "webp"));
    assert_eq!(sniff(&ftyp(b"avif")).unwrap(), ("image/avif", "avif"));
}

#[test]
fn reconnait_les_sons_sans_confondre_avec_le_jpeg() {
    // JPEG commence par 0xFF, comme une trame MPEG audio : le second octet
    // tranche (0xD8 & 0xE0 == 0xC0, pas 0xE0). Sans ça, tout JPEG arriverait
    // dans la bibliothèque de sons.
    assert_eq!(sniff(b"\xff\xd8\xff\xdb").unwrap().0, "image/jpeg");
    assert_eq!(sniff(b"\xff\xfb\x90\x00").unwrap(), ("audio/mpeg", "mp3"));
    assert_eq!(sniff(b"ID3\x04\0\0").unwrap(), ("audio/mpeg", "mp3"));
    assert_eq!(sniff(b"OggS\0\x02\0\0").unwrap(), ("audio/ogg", "ogg"));
    assert_eq!(sniff(b"RIFF\0\0\0\0WAVEfmt ").unwrap(), ("audio/wav", "wav"));
}

#[test]
fn refuse_ce_qui_ne_sert_a_rien_dans_un_overlay() {
    // mp4/mov : conteneur ISO-BMFF comme l'AVIF, mais sans canal alpha
    // exploitable par le navigateur d'OBS.
    assert!(sniff(&ftyp(b"isom")).is_none());
    assert!(sniff(&ftyp(b"qt  ")).is_none());
    assert!(sniff(b"<!DOCTYPE html>").is_none(), "une page web n'est pas une image");
    assert!(sniff(b"").is_none());
    assert!(sniff(b"\xff").is_none(), "trop court pour décider");
}

#[test]
fn classe_les_familles() {
    assert!(is_audio("audio/mpeg"));
    assert!(!is_audio("image/png"));
    // Le JPEG est accepté mais signalé : l'interface propose le détourage
    // plutôt que de laisser un rectangle blanc surgir sur le stream.
    assert!(is_opaque("image/jpeg"));
    assert!(!is_opaque("image/png"));
    assert!(!is_opaque("image/gif"));
}

// ---- Garde-fous de l'import par URL --------------------------------------
// Coller une URL ne doit pas revenir à faire sonder son réseau par l'app.

use meme4me_lib::fetch::download;

fn err(url: &str) -> String {
    download(url).expect_err(&format!("{url} aurait dû être refusé"))
}

#[test]
fn refuse_les_adresses_du_reseau_local() {
    for url in [
        "http://127.0.0.1:47821/overlay",
        "http://localhost/image.png",
        "http://192.168.1.1/admin.png",
        "http://10.0.0.5/x.png",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/x.png",
    ] {
        let e = err(url);
        assert!(
            e.contains("réseau local") || e.contains("introuvable"),
            "{url} refusé pour la mauvaise raison : {e}"
        );
    }
}

#[test]
fn refuse_les_protocoles_et_formes_douteuses() {
    // file:// lirait le disque de l'utilisateur — rejeté au niveau du protocole
    assert!(err("file:///C:/Windows/win.ini").contains("non supporté"));
    assert!(err("ftp://exemple.fr/x.png").contains("non supporté"));
    assert!(err("pas-une-url").contains("http"));
    assert!(err("http:///x.png").contains("hôte"));
    // « user@hôte » sert surtout à faire passer un hôte pour un autre à l'œil
    assert!(err("http://github.com@192.168.1.1/x.png").contains("identifiants"));
}
