//! Actions : ce qu'un déclencheur FAIT sur la machine.
//!
//! Une gesture ne savait qu'envoyer une image dans OBS. Ici elle peut ouvrir une
//! application, lancer un morceau, appuyer sur un raccourci qu'un autre logiciel
//! écoute, taper une commande, appeler un webhook. Le déclencheur reste le même
//! (`gesture_fired`) : gesture ou macro, le `ownerId` d'une action est l'un ou
//! l'autre sans distinction.
//!
//! ─── Ce qui est délibéré ────────────────────────────────────────────────────
//!
//! **Aucun shell.** `run` reçoit un programme et un tableau d'arguments, jamais
//! une ligne de commande à redécouper. Passer par `cmd /c "<chaîne>"` ferait
//! dépendre le comportement des guillemets présents dans le texte de
//! l'utilisateur — c'est exactement la fabrique à injections de commande.
//!
//! **Le réseau local est autorisé pour `http`.** À l'opposé de `fetch.rs`, qui
//! refuse le LAN parce que l'URL vient d'un collage : ici elle vient de la
//! configuration de l'utilisateur, et la moitié des usages intéressants sont
//! précisément locaux (Home Assistant, pont Hue, Streamer.bot, obs-websocket).
//!
//! **Un budget de lancements.** Une gesture peut partir plusieurs fois par
//! seconde si son seuil est trop permissif. Sans plafond, « ouvrir Notepad »
//! devient une bombe à processus. Le budget est global et glissant.

use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::diag;

/// Lancements de processus (run/open) autorisés sur une fenêtre glissante.
/// Généreux pour un usage normal, infranchissable pour une boucle emballée.
const SPAWN_BUDGET: usize = 20;
const SPAWN_WINDOW: Duration = Duration::from_secs(10);

/// Une chaîne qui traîne ne doit pas retenir son déclencheur indéfiniment.
const CHAIN_MAX: Duration = Duration::from_secs(60);

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Action {
    pub id: String,
    pub owner_id: String,
    pub kind: String,
    pub enabled: bool,
    pub order: i64,
    pub label: String,
    pub target: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub method: String,
    pub body: String,
    pub headers: String,
    pub wait_ms: u64,
    pub cooldown_ms: u64,
}

impl Default for Action {
    fn default() -> Self {
        Action {
            id: String::new(),
            owner_id: String::new(),
            kind: "open".into(),
            enabled: true,
            order: 0,
            label: String::new(),
            target: String::new(),
            args: vec![],
            cwd: String::new(),
            method: "POST".into(),
            body: String::new(),
            headers: String::new(),
            wait_ms: 500,
            cooldown_ms: 0,
        }
    }
}

impl Action {
    /// Nom lisible pour le journal — c'est ce qu'on relira après coup.
    fn name(&self) -> String {
        if !self.label.trim().is_empty() {
            return self.label.trim().to_string();
        }
        match self.kind.as_str() {
            "wait" => format!("attendre {} ms", self.wait_ms),
            "http" => format!("{} {}", self.method, self.target),
            _ => format!("{} {}", self.kind, self.target),
        }
    }
}

/// `#[serde(default)]` couvre les champs ABSENTS, pas les champs mal typés : un
/// `waitMs: null` fait échouer tout l'enregistrement. Une action disparaîtrait
/// alors à l'exécution tout en restant affichée dans l'interface — le pire mode
/// d'échec possible. D'où le journal : illisible, oui, mais jamais silencieux.
pub fn parse(values: &[Value]) -> Vec<Action> {
    let mut out: Vec<Action> = values
        .iter()
        .filter_map(|v| match serde_json::from_value::<Action>(v.clone()) {
            Ok(a) => Some(a),
            Err(e) => {
                diag::log("action", &format!("enregistrement illisible, ignoré ({e}) : {v}"));
                None
            }
        })
        .collect();
    out.sort_by_key(|a| a.order);
    out
}

// ---- Ordonnanceur -------------------------------------------------------

#[derive(Default)]
pub struct Runner {
    /// Dernier passage par action — applique son propre temps de repos.
    last: Mutex<HashMap<String, Instant>>,
    /// Déclencheurs dont la chaîne tourne encore. Sans ça, une gesture répétée
    /// empilerait des chaînes qui s'entrelaceraient dans le désordre.
    busy: Mutex<HashSet<String>>,
    /// Horodatage des derniers lancements de processus (budget glissant).
    spawns: Mutex<VecDeque<Instant>>,
}

impl Runner {
    fn cooldown_ok(&self, a: &Action) -> bool {
        if a.cooldown_ms == 0 {
            return true;
        }
        let mut last = self.last.lock().unwrap();
        let now = Instant::now();
        match last.get(&a.id) {
            Some(t) if now.duration_since(*t) < Duration::from_millis(a.cooldown_ms) => false,
            _ => {
                last.insert(a.id.clone(), now);
                true
            }
        }
    }

    /// Consomme une unité de budget, ou refuse. Appelé pour tout ce qui crée un
    /// processus — c'est la seule opération réellement dangereuse en rafale.
    fn spawn_budget_ok(&self) -> bool {
        let mut q = self.spawns.lock().unwrap();
        let now = Instant::now();
        while q.front().is_some_and(|t| now.duration_since(*t) > SPAWN_WINDOW) {
            q.pop_front();
        }
        if q.len() >= SPAWN_BUDGET {
            return false;
        }
        q.push_back(now);
        true
    }

    fn try_claim(&self, owner: &str) -> bool {
        self.busy.lock().unwrap().insert(owner.to_string())
    }

    fn release(&self, owner: &str) {
        self.busy.lock().unwrap().remove(owner);
    }
}

/// Lance la chaîne d'un déclencheur, sans jamais bloquer l'appelant : une action
/// `wait` de deux secondes ne doit pas retarder l'affichage du meme, ni geler la
/// fenêtre le temps qu'un webhook réponde.
///
/// Les échecs remontent à l'interface par un événement, en plus du journal. Une
/// action qui ne part pas silencieusement, c'est une heure passée à chercher du
/// côté d'OBS — le projet a déjà donné.
pub fn fire(app: tauri::AppHandle, runner: Arc<Runner>, actions: Vec<Action>, owner: String) {
    let live: Vec<Action> = actions.into_iter().filter(|a| a.enabled).collect();
    if live.is_empty() {
        return;
    }
    if !runner.try_claim(&owner) {
        diag::log("action", &format!("{owner} : chaîne précédente encore en cours, ignorée"));
        return;
    }
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        for a in live {
            if started.elapsed() > CHAIN_MAX {
                diag::log("action", &format!("{owner} : chaîne trop longue, interrompue"));
                break;
            }
            if !runner.cooldown_ok(&a) {
                continue;
            }
            if let Err(e) = execute(&runner, &a).await {
                report(&app, &owner, &a.name(), &e);
            }
        }
        runner.release(&owner);
    });
}

/// Nom de l'événement écouté par le Studio.
pub const FAILED_EVENT: &str = "action-failed";

fn report(app: &tauri::AppHandle, owner: &str, name: &str, err: &str) {
    diag::log("action", &format!("« {name} » a échoué : {err}"));
    use tauri::Emitter;
    let _ = app.emit(
        FAILED_EVENT,
        serde_json::json!({ "ownerId": owner, "action": name, "error": err }),
    );
}

/// Exécution d'une action isolée — sert aussi au bouton « Tester » de
/// l'interface, qui doit récupérer l'erreur au lieu de la voir passer au journal.
pub async fn execute_one(runner: Arc<Runner>, a: Action) -> Result<(), String> {
    execute(&runner, &a).await
}

async fn execute(runner: &Runner, a: &Action) -> Result<(), String> {
    match a.kind.as_str() {
        "wait" => {
            tokio::time::sleep(Duration::from_millis(a.wait_ms.min(30_000))).await;
            Ok(())
        }
        "http" => http(a).await,
        "open" | "run" => {
            if !runner.spawn_budget_ok() {
                return Err(format!(
                    "trop de lancements en peu de temps ({SPAWN_BUDGET} en {} s) — action ignorée par sécurité",
                    SPAWN_WINDOW.as_secs()
                ));
            }
            let a = a.clone();
            tauri::async_runtime::spawn_blocking(move || match a.kind.as_str() {
                "open" => sys::open(&a.target),
                _ => sys::run(&a.target, &a.args, &a.cwd),
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "keys" | "text" => {
            let a = a.clone();
            tauri::async_runtime::spawn_blocking(move || match a.kind.as_str() {
                "keys" => sys::send_chord(&a.target),
                _ => sys::send_text(&a.target),
            })
            .await
            .map_err(|e| e.to_string())?
        }
        other => Err(format!("genre d'action inconnu : {other}")),
    }
}

// ---- HTTP ---------------------------------------------------------------

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent("deck4me")
            .build()
            .expect("client http constructible")
    })
}

/// En-têtes en texte libre : « Clé: valeur » par ligne. Une ligne illisible est
/// signalée plutôt qu'avalée — sinon on cherche pendant une heure pourquoi le
/// webhook répond 401.
fn parse_headers(raw: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = vec![];
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = line
            .split_once(':')
            .ok_or_else(|| format!("en-tête sans « : » — « {line} »"))?;
        let (k, v) = (k.trim(), v.trim());
        if k.is_empty() {
            return Err(format!("en-tête sans nom — « {line} »"));
        }
        out.push((k.to_string(), v.to_string()));
    }
    Ok(out)
}

async fn http(a: &Action) -> Result<(), String> {
    let url = a.target.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("l'adresse doit commencer par http:// ou https://".into());
    }
    let method = match a.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => reqwest::Method::POST,
    };
    let mut req = client().request(method, url);
    for (k, v) in parse_headers(&a.headers)? {
        req = req.header(k, v);
    }
    if !a.body.is_empty() {
        // Content-Type deviné seulement si l'utilisateur n'en a pas mis : un
        // corps qui commence par { ou [ est du JSON dans la quasi-totalité des
        // cas, et beaucoup d'API refusent tout net sans l'en-tête.
        let b = a.body.trim_start();
        if !a.headers.to_ascii_lowercase().contains("content-type")
            && (b.starts_with('{') || b.starts_with('['))
        {
            req = req.header("content-type", "application/json");
        }
        req = req.body(a.body.clone());
    }
    let resp = req.send().await.map_err(|e| format!("requête impossible : {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // Le corps de l'erreur porte presque toujours la vraie raison.
        let detail = resp.text().await.unwrap_or_default();
        let detail: String = detail.chars().take(300).collect();
        return Err(format!("le serveur a répondu {status} — {detail}"));
    }
    diag::log("action", &format!("{} {url} → {status}", a.method));
    Ok(())
}

// ---- Système ------------------------------------------------------------

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    // ShellExecuteW : littéralement « ce que ferait un double-clic ». C'est ce
    // qui fait marcher d'un seul mécanisme un .exe, un dossier, un .lnk, une URL
    // et un URI applicatif (spotify:, steam:, obsidian:).
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show_cmd: i32,
        ) -> *mut c_void;
    }

    const SW_SHOWNORMAL: i32 = 1;

    pub fn open(target: &str) -> Result<(), String> {
        let target = target.trim();
        if target.is_empty() {
            return Err("rien à ouvrir".into());
        }
        let file = wide(target);
        let op = wide("open");
        // La valeur de retour est un pseudo-HINSTANCE : > 32 = succès. Une API
        // de 1995 qui code son erreur dans un pointeur, mais c'est le contrat.
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            ) as usize
        };
        match rc {
            r if r > 32 => Ok(()),
            2 => Err(format!("introuvable : {target}")),
            3 => Err(format!("chemin introuvable : {target}")),
            31 => Err(format!(
                "aucune application n'est associée à « {target} » sur cette machine"
            )),
            r => Err(format!("Windows a refusé d'ouvrir « {target} » (code {r})")),
        }
    }

    /// Lance un programme avec des arguments SÉPARÉS. Aucun shell n'intervient :
    /// un argument contenant des espaces ou des guillemets arrive intact, et il
    /// n'y a rien à échapper.
    pub fn run(program: &str, args: &[String], cwd: &str) -> Result<(), String> {
        let program = program.trim();
        if program.is_empty() {
            return Err("aucun programme indiqué".into());
        }
        let mut cmd = std::process::Command::new(program);
        cmd.args(args.iter().filter(|a| !a.is_empty()));
        if !cwd.trim().is_empty() {
            cmd.current_dir(cwd.trim());
        }
        // CREATE_NO_WINDOW : sans ça, un script lancé depuis une app graphique
        // fait clignoter une console noire à chaque déclenchement — en plein
        // direct, c'est visible à l'écran.
        cmd.creation_flags(0x0800_0000);
        // On ne fait délibérément PAS `wait()` : la cible peut être une
        // application qui reste ouverte, et la chaîne ne doit pas l'attendre.
        cmd.spawn()
            .map(drop)
            .map_err(|e| format!("lancement impossible ({program}) : {e}"))
    }

    // ---- Clavier synthétique ----

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeybdInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    union InputUnion {
        ki: KeybdInput,
        _pad: [u8; 32], // MOUSEINPUT, le plus gros membre de l'union
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        u: InputUnion,
    }

    // La disposition de INPUT est un contrat ABI avec le système. Une erreur ici
    // ne planterait pas : SendInput renverrait simplement 0, en silence.
    #[cfg(target_arch = "x86_64")]
    const _: () = assert!(std::mem::size_of::<Input>() == 40);

    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const KEYEVENTF_UNICODE: u32 = 0x0004;

    #[link(name = "user32")]
    extern "system" {
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    }

    fn key_event(vk: u16, scan: u16, flags: u32) -> Input {
        Input {
            kind: INPUT_KEYBOARD,
            u: InputUnion {
                ki: KeybdInput { vk, scan, flags, time: 0, extra: 0 },
            },
        }
    }

    fn send(batch: &[Input]) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let sent = unsafe {
            SendInput(
                batch.len() as u32,
                batch.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            )
        };
        if sent as usize == batch.len() {
            Ok(())
        } else {
            // Cas classique : la fenêtre au premier plan tourne en administrateur
            // et deck4me non. L'UIPI bloque alors l'injection, sans autre signe.
            Err("Windows a refusé l'envoi clavier — la fenêtre active tourne \
                 probablement en administrateur, contrairement à deck4me"
                .into())
        }
    }

    /// Touches du pavé étendu : sans le drapeau, Windows confond les flèches
    /// avec le pavé numérique et « Suppr » avec le point décimal.
    fn is_extended(vk: u16) -> bool {
        matches!(
            vk,
            0x21..=0x28 // pgup, pgdn, end, home, ← ↑ → ↓
                | 0x2D | 0x2E // insert, delete
                | 0x2C // impr. écran
                | 0x90 // verr. num
                | 0xA5 // alt droite
                | 0xAD..=0xB3 // touches multimédia
        )
    }

    pub fn send_chord(chord: &str) -> Result<(), String> {
        let (mods, key) = super::parse_chord(chord)?;
        let mut batch = Vec::with_capacity(8);
        for &m in &mods {
            batch.push(key_event(m, 0, 0));
        }
        let ext = if is_extended(key) { KEYEVENTF_EXTENDEDKEY } else { 0 };
        batch.push(key_event(key, 0, ext));
        batch.push(key_event(key, 0, ext | KEYEVENTF_KEYUP));
        // Relâchement en ordre inverse : c'est ce que fait une vraie main, et
        // certaines applications suivent la pile de modificateurs.
        for &m in mods.iter().rev() {
            batch.push(key_event(m, 0, KEYEVENTF_KEYUP));
        }
        send(&batch)
    }

    /// Frappe littérale, en UTF-16 : Windows accepte n'importe quel caractère
    /// par KEYEVENTF_UNICODE, sans dépendre de la disposition du clavier. Une
    /// simulation par codes de touches taperait « qzerty » sur un clavier AZERTY.
    pub fn send_text(text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Err("texte vide".into());
        }
        let mut batch = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            batch.push(key_event(0, unit, KEYEVENTF_UNICODE));
            batch.push(key_event(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        // SendInput plafonne en pratique ; on découpe pour rester tranquille.
        for chunk in batch.chunks(256) {
            send(chunk)?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod sys {
    const NOPE: &str = "action disponible sur Windows uniquement";
    pub fn open(_t: &str) -> Result<(), String> {
        Err(NOPE.into())
    }
    pub fn run(_p: &str, _a: &[String], _c: &str) -> Result<(), String> {
        Err(NOPE.into())
    }
    pub fn send_chord(_c: &str) -> Result<(), String> {
        Err(NOPE.into())
    }
    pub fn send_text(_t: &str) -> Result<(), String> {
        Err(NOPE.into())
    }
}

// ---- Table des touches --------------------------------------------------
//
// Cette table fait AUTORITÉ. L'interface la lit par la commande `key_names` au
// lieu d'en tenir une copie : deux listes à maintenir, c'est deux listes qui
// divergent, et la divergence ne se voit qu'au moment où le raccourci ne part
// pas en plein direct.

/// Nom canonique → code de touche virtuelle Windows.
pub fn key_names() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = NAMED.iter().map(|(n, _)| *n).collect();
    v.sort_unstable();
    v
}

const NAMED: &[(&str, u16)] = &[
    ("Backspace", 0x08),
    ("Tab", 0x09),
    ("Enter", 0x0D),
    ("Pause", 0x13),
    ("CapsLock", 0x14),
    ("Escape", 0x1B),
    ("Space", 0x20),
    ("PageUp", 0x21),
    ("PageDown", 0x22),
    ("End", 0x23),
    ("Home", 0x24),
    ("Left", 0x25),
    ("Up", 0x26),
    ("Right", 0x27),
    ("Down", 0x28),
    ("PrintScreen", 0x2C),
    ("Insert", 0x2D),
    ("Delete", 0x2E),
    // Multimédia : reconnues par Spotify, VLC, YouTube Music et à peu près tout
    // ce qui joue du son — sans la moindre intégration ni compte à connecter.
    ("VolumeMute", 0xAD),
    ("VolumeDown", 0xAE),
    ("VolumeUp", 0xAF),
    ("MediaNextTrack", 0xB0),
    ("MediaPrevTrack", 0xB1),
    ("MediaStop", 0xB2),
    ("MediaPlayPause", 0xB3),
    ("NumpadAdd", 0x6B),
    ("NumpadSubtract", 0x6D),
    ("NumpadMultiply", 0x6A),
    ("NumpadDivide", 0x6F),
];

fn vk_of(token: &str) -> Option<u16> {
    let t = token.trim();
    if t.is_empty() {
        return None;
    }
    // Lettre ou chiffre isolé : les codes ASCII majuscules SONT les codes de
    // touches virtuelles pour A–Z et 0–9. Pas de table à écrire.
    let chars: Vec<char> = t.chars().collect();
    if chars.len() == 1 {
        let c = chars[0].to_ascii_uppercase();
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(c as u16);
        }
    }
    let low = t.to_ascii_lowercase();
    // F1 … F24
    if let Some(n) = low.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    // Numpad0 … Numpad9
    if let Some(n) = low.strip_prefix("numpad").and_then(|n| n.parse::<u16>().ok()) {
        if n <= 9 {
            return Some(0x60 + n);
        }
    }
    NAMED
        .iter()
        .find(|(n, _)| n.to_ascii_lowercase() == low)
        .map(|(_, v)| *v)
}

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12; // Alt
const VK_LWIN: u16 = 0x5B;

/// « Ctrl+Shift+M » → (modificateurs, touche). Les modificateurs sortent dans
/// un ordre stable, indépendant de celui de la saisie.
pub fn parse_chord(chord: &str) -> Result<(Vec<u16>, u16), String> {
    let parts: Vec<&str> = chord.split('+').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("raccourci vide".into());
    }
    let (mut ctrl, mut alt, mut shift, mut win) = (false, false, false, false);
    let mut key: Option<u16> = None;
    for p in &parts {
        match p.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "cmdorctrl" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "win" | "meta" | "super" | "cmd" => win = true,
            _ => {
                if key.is_some() {
                    return Err(format!("deux touches dans « {chord} » — une seule est permise"));
                }
                key = Some(vk_of(p).ok_or_else(|| format!("touche inconnue : « {p} »"))?);
            }
        }
    }
    let key = key.ok_or("il manque une touche après les modificateurs")?;
    let mut mods = vec![];
    if ctrl {
        mods.push(VK_CONTROL);
    }
    if alt {
        mods.push(VK_MENU);
    }
    if shift {
        mods.push(VK_SHIFT);
    }
    if win {
        mods.push(VK_LWIN);
    }
    Ok((mods, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lettres_et_chiffres_sont_leur_propre_code() {
        assert_eq!(vk_of("a"), Some(0x41));
        assert_eq!(vk_of("A"), Some(0x41));
        assert_eq!(vk_of("7"), Some(0x37));
    }

    #[test]
    fn touches_de_fonction_et_pave() {
        assert_eq!(vk_of("F1"), Some(0x70));
        assert_eq!(vk_of("f24"), Some(0x87));
        assert_eq!(vk_of("F25"), None);
        assert_eq!(vk_of("Numpad0"), Some(0x60));
    }

    #[test]
    fn touches_nommees_insensibles_a_la_casse() {
        assert_eq!(vk_of("mediaplaypause"), Some(0xB3));
        assert_eq!(vk_of("MediaPlayPause"), Some(0xB3));
    }

    #[test]
    fn accord_complet() {
        let (mods, key) = parse_chord("Ctrl+Shift+M").unwrap();
        assert_eq!(mods, vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(key, 0x4D);
    }

    /// L'ordre de saisie ne doit pas changer ce qui est envoyé.
    #[test]
    fn ordre_des_modificateurs_normalise() {
        assert_eq!(parse_chord("Shift+Ctrl+A").unwrap(), parse_chord("Ctrl+Shift+A").unwrap());
    }

    #[test]
    fn touche_seule_sans_modificateur() {
        assert_eq!(parse_chord("MediaPlayPause").unwrap(), (vec![], 0xB3));
    }

    #[test]
    fn refus_explicites() {
        assert!(parse_chord("Ctrl").is_err(), "modificateur seul");
        assert!(parse_chord("Ctrl+A+B").is_err(), "deux touches");
        assert!(parse_chord("Ctrl+Bidule").is_err(), "touche inconnue");
        assert!(parse_chord("").is_err(), "vide");
    }

    /// Toute la table doit se résoudre : une entrée mal orthographiée serait
    /// proposée dans l'interface et refusée à l'exécution.
    #[test]
    fn table_coherente_avec_le_parseur() {
        for name in key_names() {
            assert!(vk_of(name).is_some(), "« {name} » ne se résout pas");
            assert!(parse_chord(name).is_ok(), "« {name} » ne s'analyse pas comme accord");
        }
    }

    #[test]
    fn entetes_libres() {
        let h = parse_headers("Authorization: Bearer xyz\n# commentaire\n\nX-A:1").unwrap();
        assert_eq!(
            h,
            vec![
                ("Authorization".into(), "Bearer xyz".into()),
                ("X-A".into(), "1".into())
            ]
        );
    }

    #[test]
    fn entete_illisible_signale_plutot_qu_avale() {
        assert!(parse_headers("Authorization Bearer xyz").is_err());
        assert!(parse_headers(": vide").is_err());
    }

    #[test]
    fn budget_de_lancement_plafonne() {
        let r = Runner::default();
        for i in 0..SPAWN_BUDGET {
            assert!(r.spawn_budget_ok(), "lancement {i} refusé trop tôt");
        }
        assert!(!r.spawn_budget_ok(), "le budget devrait être épuisé");
    }

    #[test]
    fn un_declencheur_ne_lance_qu_une_chaine_a_la_fois() {
        let r = Runner::default();
        assert!(r.try_claim("g1"));
        assert!(!r.try_claim("g1"));
        assert!(r.try_claim("g2"), "un autre déclencheur reste libre");
        r.release("g1");
        assert!(r.try_claim("g1"));
    }

    #[test]
    fn temps_de_repos_par_action() {
        let r = Runner::default();
        let a = Action { id: "a1".into(), cooldown_ms: 10_000, ..Default::default() };
        assert!(r.cooldown_ok(&a));
        assert!(!r.cooldown_ok(&a));
        let libre = Action { id: "a2".into(), cooldown_ms: 0, ..Default::default() };
        assert!(r.cooldown_ok(&libre));
        assert!(r.cooldown_ok(&libre), "sans repos configuré, jamais bloquée");
    }

    #[test]
    fn parse_trie_par_ordre_et_ignore_les_illisibles() {
        let vals = vec![
            serde_json::json!({ "id": "b", "ownerId": "g", "order": 2, "kind": "open" }),
            serde_json::json!({ "id": "a", "ownerId": "g", "order": 1, "kind": "open" }),
            serde_json::json!({ "order": "pas un nombre" }),
        ];
        let out = parse(&vals);
        assert_eq!(out.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }
}
