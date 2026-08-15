//! Caméra virtuelle « facememe Camera ».
//!
//! Principe : facememe devient l'UNIQUE process qui ouvre la webcam physique
//! (capture Media Foundation, mode partagé), et republie le flux via le filtre
//! DirectShow softcam (vendor/softcam, MIT, renommé). Streamlabs — et
//! n'importe quelle app DirectShow — consomme « facememe Camera » comme une
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
    pub camera: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamDevice {
    pub index: u32,
    pub name: String,
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
                .filter(|d| !d.name.contains("facememe"))
                .collect(),
            Err(_) => vec![],
        }
    }

    pub fn is_registered() -> bool {
        std::process::Command::new("reg")
            .args([
                "query",
                &format!("HKCR\\CLSID\\{FILTER_CLSID}\\InprocServer32"),
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Lance regsvr32 élevé (UAC) via PowerShell. `unregister` pour retirer.
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
            "Start-Process regsvr32 -ArgumentList {flag}'\"{dll}\"' -Verb RunAs -Wait"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
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

    pub fn start(&self, camera_index: u32) -> Result<VcamStatus, String> {
        if self.status.lock().unwrap().running {
            return Ok(self.status());
        }
        if !Self::is_registered() {
            return Err("Le filtre n'est pas installé (bouton « Installer »)".into());
        }
        self.stop.store(false, Ordering::SeqCst);
        let dll_path = self.dll_path.clone();
        let stop = self.stop.clone();
        let status = self.status.clone();

        let handle = std::thread::Builder::new()
            .name("vcam-pump".into())
            .spawn(move || {
                if let Err(e) = pump(dll_path, camera_index, &stop, &status) {
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

/// Boucle de pompage : webcam physique (MF partagé) → BGR → softcam.
/// Tout est créé DANS le thread : aucun handle ne traverse les threads.
fn pump(
    dll_path: PathBuf,
    camera_index: u32,
    stop: &AtomicBool,
    status: &Mutex<VcamStatus>,
) -> Result<(), String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{
        CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType, Resolution,
    };

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

    // 720p30 en MJPEG si possible, sinon le plus proche disponible.
    let wanted = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(
        CameraFormat::new(Resolution::new(1280, 720), FrameFormat::MJPEG, 30),
    ));
    let mut camera = nokhwa::Camera::new(CameraIndex::Index(camera_index), wanted)
        .map_err(|e| format!("ouverture caméra : {e}"))?;
    let name = camera.info().human_name();
    camera
        .open_stream()
        .map_err(|e| format!("démarrage du flux : {e}"))?;

    // Première frame → dimensions réelles (multiples de 4 exigés par softcam)
    let first = camera.frame().map_err(|e| e.to_string())?;
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
    let mut frames = 0u32;
    let mut window_start = Instant::now();

    let result = loop {
        if stop.load(Ordering::SeqCst) {
            break Ok(());
        }
        let frame = match camera.frame() {
            Ok(f) => f,
            Err(e) => break Err(format!("caméra perdue : {e}")),
        };
        let img = match frame.decode_image::<RgbFormat>() {
            Ok(i) => i,
            Err(e) => break Err(format!("décodage : {e}")),
        };
        let rgb = img.as_raw();
        // RGB (nokhwa) → BGR (convention DirectShow), avec recadrage éventuel
        // aux multiples de 4. Boucle serrée : ~27 Mo/s à 720p30, négligeable.
        let src_stride = (src_w * 3) as usize;
        for y in 0..h as usize {
            let src_row = y * src_stride;
            let dst_row = y * (w as usize) * 3;
            for x in 0..w as usize {
                let s = src_row + x * 3;
                let d = dst_row + x * 3;
                bgr[d] = rgb[s + 2];
                bgr[d + 1] = rgb[s + 1];
                bgr[d + 2] = rgb[s];
            }
        }
        unsafe { sc_send(cam_handle, bgr.as_ptr() as *const c_void) };

        frames += 1;
        if window_start.elapsed().as_secs_f32() >= 1.0 {
            let mut s = status.lock().unwrap();
            s.fps = frames as f32 / window_start.elapsed().as_secs_f32();
            s.connected = unsafe { sc_connected(cam_handle) };
            frames = 0;
            window_start = Instant::now();
        }
    };

    unsafe { sc_delete(cam_handle) };
    result
}
