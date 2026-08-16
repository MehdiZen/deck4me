//! Caméra virtuelle « deck4me Camera ».
//!
//! Principe : deck4me devient l'UNIQUE process qui ouvre la webcam physique
//! (capture Media Foundation, mode partagé), et republie le flux via le filtre
//! DirectShow softcam (vendor/softcam, MIT, renommé). Streamlabs — et
//! n'importe quelle app DirectShow — consomme « deck4me Camera » comme une
//! webcam normale. Plus de conflit d'accès exclusif.
//!
//! L'enregistrement du filtre (regsvr32) exige une élévation UAC : il est
//! déclenché par un clic utilisateur dans Réglages, jamais automatiquement.

use serde::Serialize;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const FILTER_CLSID: &str = "{AEF3B972-5FA5-4647-9571-358EB472BC9E}";

/// CREATE_NO_WINDOW : empêche l'apparition d'une console quand une app GUI
/// lance un processus.
#[cfg(windows)]
fn no_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut std::process::Command) {}

type ScCreateCamera = unsafe extern "C" fn(i32, i32, f32) -> *mut c_void;
type ScDeleteCamera = unsafe extern "C" fn(*mut c_void);
type ScSendFrame = unsafe extern "C" fn(*mut c_void, *const c_void);
type ScIsConnected = unsafe extern "C" fn(*mut c_void) -> bool;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamStatus {
    pub registered: bool,
    pub running: bool,
    /// Une application (Streamlabs…) lit actuellement le flux virtuel.
    pub connected: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    /// Découpage du temps passé sur une image, en millisecondes, lissé sur ~1 s.
    ///
    /// Sans ça, une pompe à 17 fps sur une caméra capable de 60 ne dit pas OÙ
    /// partent les 42 ms manquantes : attendre l'image de la webcam, la
    /// décoder, ou la convertir. Trois causes, trois correctifs sans rapport —
    /// et deux chances sur trois de réécrire le mauvais code.
    pub grab_ms: f32,
    pub decode_ms: f32,
    pub convert_ms: f32,
    pub camera: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamDevice {
    pub index: u32,
    pub name: String,
}

/// Un mode réellement supporté par la webcam (pas une supposition).
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamFormat {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub struct VirtualCam {
    dll_path: PathBuf,
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<VcamStatus>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl VirtualCam {
    pub fn new(dll_path: PathBuf) -> VirtualCam {
        VirtualCam {
            dll_path,
            stop: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(VcamStatus::default())),
            thread: Mutex::new(None),
        }
    }

    pub fn devices() -> Vec<VcamDevice> {
        match nokhwa::query(nokhwa::utils::ApiBackend::MediaFoundation) {
            Ok(list) => list
                .iter()
                .filter_map(|c| match c.index() {
                    nokhwa::utils::CameraIndex::Index(i) => Some(VcamDevice {
                        index: *i,
                        name: c.human_name(),
                    }),
                    _ => None,
                })
                // ne jamais proposer de se recapturer soi-même
                // Ancien nom compris : sur une machine qui a connu meme4me, le
                // filtre reste déclaré sous « meme4me Camera » tant qu'il n'a
                // pas été réenregistré. L'oublier ici laisserait la pompe
                // choisir sa PROPRE sortie comme source — une boucle.
                .filter(|d| !d.name.contains("deck4me") && !d.name.contains("meme4me"))
                .collect(),
            Err(_) => vec![],
        }
    }

    /// Lecture directe du registre — surtout PAS un `reg.exe` : depuis une app
    /// GUI, chaque processus console fait clignoter une fenêtre, et le statut
    /// est sondé en continu par l'UI.
    /// Modes réellement diffusables par la webcam. Il faut l'ouvrir pour les
    /// connaître : si elle est occupée, on renvoie une liste vide et l'UI
    /// retombe sur la négociation automatique.
    pub fn formats(index: u32) -> Vec<VcamFormat> {
        use nokhwa::pixel_format::RgbFormat;
        use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType};

        let Ok(mut cam) = nokhwa::Camera::new(
            CameraIndex::Index(index),
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
        ) else {
            return vec![];
        };
        let Ok(list) = cam.compatible_camera_formats() else {
            return vec![];
        };

        // Une seule entrée par résolution : la meilleure cadence disponible.
        let mut best: std::collections::HashMap<(u32, u32), u32> = Default::default();
        for f in list {
            let key = (f.resolution().width(), f.resolution().height());
            let e = best.entry(key).or_insert(0);
            *e = (*e).max(f.frame_rate());
        }
        let mut out: Vec<VcamFormat> = best
            .into_iter()
            // softcam exige des dimensions multiples de 4
            .filter(|((w, h), _)| w % 4 == 0 && h % 4 == 0 && *w >= 320)
            .map(|((width, height), fps)| VcamFormat { width, height, fps })
            .collect();
        out.sort_by_key(|f| std::cmp::Reverse((f.width * f.height, f.fps)));
        out
    }

    pub fn is_registered() -> bool {
        use winreg::enums::HKEY_CLASSES_ROOT;
        use winreg::RegKey;
        RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey(format!("CLSID\\{FILTER_CLSID}\\InprocServer32"))
            .is_ok()
    }

    /// Lance regsvr32 élevé (UAC) via PowerShell. `unregister` pour retirer.
    /// Seul le dialogue UAC doit être visible : l'hôte PowerShell est masqué.
    pub fn register(&self, unregister: bool) -> Result<(), String> {
        let dll = self
            .dll_path
            .to_str()
            .ok_or("chemin DLL invalide")?
            .to_string();
        if !self.dll_path.exists() {
            return Err(format!("softcam.dll introuvable : {dll}"));
        }
        let flag = if unregister { "'/u','/s'," } else { "'/s'," };
        let ps = format!(
            "Start-Process regsvr32 -ArgumentList {flag}'\"{dll}\"' -Verb RunAs -Wait -WindowStyle Hidden"
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps]);
        no_window(&mut cmd);
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                "élévation refusée ou annulée".into()
            } else {
                err
            });
        }
        Ok(())
    }

    pub fn status(&self) -> VcamStatus {
        let mut s = self.status.lock().unwrap().clone();
        s.registered = Self::is_registered();
        s
    }

    pub fn stop(&self) -> VcamStatus {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
        self.status()
    }

    pub fn start(
        &self,
        camera_index: u32,
        wanted: Option<VcamFormat>,
    ) -> Result<VcamStatus, String> {
        if self.status.lock().unwrap().running {
            return Ok(self.status());
        }
        if !Self::is_registered() {
            return Err("Le pilote n'est pas installé (bouton « Installer le pilote »)".into());
        }
        self.stop.store(false, Ordering::SeqCst);
        let dll_path = self.dll_path.clone();
        let stop = self.stop.clone();
        let status = self.status.clone();

        let handle = std::thread::Builder::new()
            .name("vcam-pump".into())
            .spawn(move || {
                if let Err(e) = pump(dll_path, camera_index, wanted, &stop, &status) {
                    let mut s = status.lock().unwrap();
                    s.error = Some(e);
                }
                let mut s = status.lock().unwrap();
                s.running = false;
                s.connected = false;
            })
            .map_err(|e| e.to_string())?;
        *self.thread.lock().unwrap() = Some(handle);

        // laisse le temps au thread d'échouer franchement (caméra occupée…)
        std::thread::sleep(std::time::Duration::from_millis(700));
        let s = self.status();
        if let Some(err) = &s.error {
            if !s.running {
                return Err(err.clone());
            }
        }
        Ok(s)
    }
}

/// Traduit les erreurs Media Foundation en consigne actionnable.
/// 0xC00D3704 (MF_E_HW_MFT_FAILED_START_STREAMING) veut presque toujours dire
/// « le périphérique est déjà pris », pas « matériel insuffisant » malgré son
/// libellé Windows.
fn explain_camera_error(raw: &str) -> String {
    if raw.contains("0xC00D3704") || raw.contains("C00D3704") {
        "Impossible de démarrer le flux de cette webcam. Elle est presque \
         toujours déjà utilisée : ferme OBS, Streamlabs, Discord ou Teams \
         (il suffit qu'une source caméra y soit ouverte), puis réessaie."
            .into()
    } else if raw.contains("0xC00D3E85") || raw.contains("not found") {
        "Webcam introuvable — a-t-elle été débranchée ? Clique « Actualiser ».".into()
    } else if raw.contains("0xC00DABE0") || raw.contains("access") || raw.contains("Access") {
        "Accès à la webcam refusé. Vérifie Paramètres Windows → Confidentialité \
         → Caméra, et autorise les applications de bureau."
            .into()
    } else {
        raw.to_string()
    }
}

/// Ouvre la caméra dans un format donné et vérifie qu'elle délivre vraiment une
/// image : sous Media Foundation, l'ouverture peut réussir et le flux échouer
/// juste après. Tant qu'aucune frame n'est arrivée, rien n'est acquis.
fn try_open(
    index: u32,
    req: nokhwa::utils::RequestedFormatType,
) -> Result<(nokhwa::Camera, nokhwa::Buffer), String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{CameraIndex, RequestedFormat};

    let mut cam = nokhwa::Camera::new(
        CameraIndex::Index(index),
        RequestedFormat::new::<RgbFormat>(req),
    )
    .map_err(|e| e.to_string())?;
    cam.open_stream().map_err(|e| e.to_string())?;
    match cam.frame() {
        Ok(f) => Ok((cam, f)),
        Err(e) => {
            let _ = cam.stop_stream(); // libérer avant d'essayer le format suivant
            Err(e.to_string())
        }
    }
}

/// Boucle de pompage : webcam physique (MF partagé) → BGR → softcam.
/// Tout est créé DANS le thread : aucun handle ne traverse les threads.
fn pump(
    dll_path: PathBuf,
    camera_index: u32,
    wanted: Option<VcamFormat>,
    stop: &AtomicBool,
    status: &Mutex<VcamStatus>,
) -> Result<(), String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{CameraFormat, FrameFormat, RequestedFormatType, Resolution};

    {
        let mut s = status.lock().unwrap();
        s.error = None;
    }

    let lib = unsafe { libloading::Library::new(&dll_path) }
        .map_err(|e| format!("chargement softcam.dll : {e}"))?;
    let sc_create: libloading::Symbol<ScCreateCamera> =
        unsafe { lib.get(b"scCreateCamera") }.map_err(|e| e.to_string())?;
    let sc_delete: libloading::Symbol<ScDeleteCamera> =
        unsafe { lib.get(b"scDeleteCamera") }.map_err(|e| e.to_string())?;
    let sc_send: libloading::Symbol<ScSendFrame> =
        unsafe { lib.get(b"scSendFrame") }.map_err(|e| e.to_string())?;
    let sc_connected: libloading::Symbol<ScIsConnected> =
        unsafe { lib.get(b"scIsConnected") }.map_err(|e| e.to_string())?;

    // Une webcam n'accepte pas n'importe quelle combinaison résolution/codec :
    // exiger du 720p MJPEG en dur fait échouer le démarrage du flux avec le
    // même 0xC00D3704 qu'un périphérique occupé. On essaie donc plusieurs
    // formats, du plus souhaitable au plus permissif, et on ne retient que
    // celui qui délivre réellement une image.
    // Le mode choisi par l'utilisateur passe en premier ; les suivants sont
    // des filets, pour qu'un choix impossible ne bloque jamais le démarrage.
    let chosen = wanted.map(|f| {
        RequestedFormatType::Closest(CameraFormat::new(
            Resolution::new(f.width, f.height),
            FrameFormat::MJPEG,
            f.fps,
        ))
    });
    let candidates: Vec<RequestedFormatType> = chosen
        .into_iter()
        .chain([
            RequestedFormatType::Closest(CameraFormat::new(
                Resolution::new(1280, 720),
                FrameFormat::MJPEG,
                30,
            )),
            RequestedFormatType::Closest(CameraFormat::new(
                Resolution::new(640, 480),
                FrameFormat::MJPEG,
                30,
            )),
            RequestedFormatType::AbsoluteHighestFrameRate,
            RequestedFormatType::AbsoluteHighestResolution,
            RequestedFormatType::None,
        ])
        .collect();

    let mut camera = None;
    let mut first_frame = None;
    let mut last_err = String::new();
    for req in candidates {
        match try_open(camera_index, req) {
            Ok((cam, frame)) => {
                camera = Some(cam);
                first_frame = Some(frame);
                break;
            }
            Err(e) => last_err = e,
        }
    }
    let (Some(mut camera), Some(first)) = (camera, first_frame) else {
        return Err(explain_camera_error(&last_err));
    };
    let name = camera.info().human_name();

    // Première frame → dimensions réelles (multiples de 4 exigés par softcam)
    let img = first.decode_image::<RgbFormat>().map_err(|e| e.to_string())?;
    let (src_w, src_h) = (img.width(), img.height());
    let w = src_w & !3;
    let h = src_h & !3;
    if w == 0 || h == 0 {
        return Err(format!("dimensions caméra invalides : {src_w}x{src_h}"));
    }

    // framerate 0 = temps réel : la webcam impose la cadence, softcam suit.
    let cam_handle = unsafe { sc_create(w as i32, h as i32, 0.0) };
    if cam_handle.is_null() {
        return Err(
            "création de la caméra virtuelle refusée (une autre instance tourne ?)".into(),
        );
    }

    {
        let mut s = status.lock().unwrap();
        s.running = true;
        s.width = w;
        s.height = h;
        s.camera = Some(name);
    }

    let mut bgr = vec![0u8; (w * h * 3) as usize];
    let mut rgb = vec![0u8; (src_w * src_h * 3) as usize];
    let mut frames = 0u32;
    let mut window_start = Instant::now();
    let (mut grab_acc, mut dec_acc, mut conv_acc) = (0.0f32, 0.0f32, 0.0f32);

    let result = loop {
        if stop.load(Ordering::SeqCst) {
            break Ok(());
        }
        let t0 = Instant::now();
        let frame = match camera.frame() {
            Ok(f) => f,
            Err(e) => break Err(format!("caméra perdue : {e}")),
        };
        let t_grab = Instant::now();
        // Décodage dans un tampon réutilisé : décoder vers une image neuve
        // à chaque frame, c'est 11 Mo alloués puis jetés 30 fois par seconde
        // en 1440p — le processeur passe son temps à gérer de la mémoire.
        if let Err(e) = frame.decode_image_to_buffer::<RgbFormat>(&mut rgb) {
            break Err(format!("décodage : {e}"))
        }
        let t_dec = Instant::now();

        // RGB (nokhwa) → BGR (convention DirectShow), avec recadrage éventuel
        // aux multiples de 4. Par tranches plutôt que par indices : le
        // compilateur élimine les vérifications de bornes et vectorise.
        let src_stride = (src_w * 3) as usize;
        let dst_stride = (w * 3) as usize;
        for (dst_row, src_row) in bgr
            .chunks_exact_mut(dst_stride)
            .zip(rgb.chunks_exact(src_stride))
        {
            for (d, s) in dst_row
                .chunks_exact_mut(3)
                .zip(src_row.chunks_exact(3))
            {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
            }
        }
        unsafe { sc_send(cam_handle, bgr.as_ptr() as *const c_void) };
        let t_end = Instant::now();

        grab_acc += (t_grab - t0).as_secs_f32() * 1000.0;
        dec_acc += (t_dec - t_grab).as_secs_f32() * 1000.0;
        conv_acc += (t_end - t_dec).as_secs_f32() * 1000.0;
        frames += 1;
        if window_start.elapsed().as_secs_f32() >= 1.0 {
            let mut s = status.lock().unwrap();
            s.fps = frames as f32 / window_start.elapsed().as_secs_f32();
            let n = frames.max(1) as f32;
            s.grab_ms = grab_acc / n;
            s.decode_ms = dec_acc / n;
            s.convert_ms = conv_acc / n;
            grab_acc = 0.0;
            dec_acc = 0.0;
            conv_acc = 0.0;
            s.connected = unsafe { sc_connected(cam_handle) };
            frames = 0;
            window_start = Instant::now();
        }
    };

    unsafe { sc_delete(cam_handle) };
    result
}
