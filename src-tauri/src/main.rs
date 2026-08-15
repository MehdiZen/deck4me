#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Leçon de la phase 0 (test B2) : sans ces flags, WebView2 throttle la
    // détection dès que la fenêtre est minimisée ou recouverte par le jeu.
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required",
    );
    facememe_lib::run()
}
