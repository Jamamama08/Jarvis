//! JARVIS desktop shell.
//!
//! The webview renders the same React frontend as the web app and talks to the
//! local FastAPI backend at http://127.0.0.1:8765. Desktop-only capabilities
//! (approved app control, sidecar backend management) are added in later phases
//! as explicit, permission-checked Tauri commands.

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running JARVIS desktop");
}
