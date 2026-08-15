//! Import d'un asset depuis une URL.
//!
//! Le téléchargement se fait ICI et pas dans la webview, pour deux raisons :
//! la webview se ferait refuser la moitié des liens par CORS, et surtout coller
//! une URL ne doit pas revenir à faire sonder ton réseau local par l'app. D'où
//! le filtre d'adresses ci-dessous : sans lui, `http://192.168.1.1/` ou
//! `http://localhost:47821/` deviendraient des requêtes que l'app émet pour le
//! compte de qui a fourni le lien.

use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

/// Au-delà, ce n'est plus un meme. Le plafond est appliqué pendant la lecture,
/// pas seulement d'après l'en-tête Content-Length : un serveur peut mentir.
const MAX_BYTES: usize = 25 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                // 100.64.0.0/10 (CGNAT) et 169.254.0.0/16 déjà couvert au-dessus
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 (unique local) et fe80::/10 (lien local)
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // ::ffff:a.b.c.d — une adresse privée déguisée en IPv6
                || v6.to_ipv4_mapped().map(|v4| is_private(&IpAddr::V4(v4))).unwrap_or(false)
        }
    }
}

/// Vérifie que l'hôte ne résout vers aucune adresse du réseau local.
/// On refuse dès qu'UNE des adresses est privée : un nom qui répond à la fois
/// en public et en local n'est pas un nom de confiance.
fn host_is_public(host: &str, port: u16) -> Result<(), String> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("nom d'hôte introuvable : {e}"))?;
    let mut any = false;
    for a in addrs {
        any = true;
        if is_private(&a.ip()) {
            return Err(
                "ce lien pointe vers le réseau local — meme4me ne va chercher que sur Internet"
                    .into(),
            )
        }
    }
    if any {
        Ok(())
    } else {
        Err("nom d'hôte introuvable".into())
    }
}

/// Nom de fichier déduit de l'URL, pour que l'asset reste reconnaissable dans
/// la liste. L'extension réelle vient toujours du `sniff()` des octets.
fn filename_from(url: &url_lite::Parsed) -> String {
    url.path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .map(|s| s.split(['?', '#']).next().unwrap_or(s).to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image-web".into())
}

/// Analyse minimale d'URL — suffisante ici, et évite une dépendance de plus.
mod url_lite {
    pub struct Parsed {
        pub host: String,
        pub port: u16,
        pub path: String,
    }

    pub fn parse(raw: &str) -> Result<Parsed, String> {
        let raw = raw.trim();
        let (scheme, rest) = raw
            .split_once("://")
            .ok_or("l'adresse doit commencer par http:// ou https://")?;
        let default_port = match scheme.to_ascii_lowercase().as_str() {
            "https" => 443,
            "http" => 80,
            other => return Err(format!("protocole non supporté : {other}")),
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], rest[i..].to_string()),
            None => (rest, "/".to_string()),
        };
        // Les identifiants dans l'URL (user:pass@hôte) servent surtout à faire
        // passer un hôte pour un autre à l'œil nu : on refuse.
        if authority.contains('@') {
            return Err("les adresses avec identifiants ne sont pas acceptées".into())
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
                (h.to_string(), p.parse().unwrap_or(default_port))
            }
            _ => (authority.to_string(), default_port),
        };
        if host.is_empty() {
            return Err("adresse sans nom d'hôte".into())
        }
        Ok(Parsed { host, port, path })
    }
}

/// Télécharge et renvoie les octets bruts. Le contenu n'est PAS interprété ici :
/// c'est `store::sniff` qui décide de ce que c'est, sur les octets et jamais sur
/// ce que le serveur prétend dans son Content-Type.
pub fn download(raw_url: &str) -> Result<(Vec<u8>, String), String> {
    let parsed = url_lite::parse(raw_url)?;
    host_is_public(&parsed.host, parsed.port)?;

    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        // Une redirection peut ramener vers le réseau local après le contrôle :
        // on les refuse plutôt que de revalider à chaque saut.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("meme4me")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(raw_url.trim())
        .send()
        .map_err(|e| format!("téléchargement impossible : {e}"))?;

    if resp.status().is_redirection() {
        let to = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("une autre adresse");
        return Err(format!("ce lien redirige vers {to} — colle l'adresse finale de l'image"))
    }
    if !resp.status().is_success() {
        return Err(format!("le serveur a répondu {}", resp.status()))
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_BYTES {
            return Err(format!("fichier trop lourd ({} Mo, maximum 25)", len / 1_048_576))
        }
    }

    use std::io::Read;
    let mut buf = Vec::new();
    resp.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("lecture interrompue : {e}"))?;
    if buf.len() > MAX_BYTES {
        return Err("fichier trop lourd (maximum 25 Mo)".into())
    }
    if buf.is_empty() {
        return Err("le serveur a renvoyé un fichier vide".into())
    }
    Ok((buf, filename_from(&parsed)))
}
