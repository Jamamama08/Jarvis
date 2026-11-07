//! JARVIS desktop shell.
//!
//! The webview renders the same React frontend as the web app. In release builds the
//! app starts the bundled backend (the `jarvis-backend` sidecar, built by
//! scripts/build-sidecar) on 127.0.0.1:8765 with its data in the app-data folder, and
//! stops it on exit. If a backend is already listening there (e.g. `scripts/dev` during
//! development), that one is used instead.
//!
//! Desktop control (launching approved apps) runs in the backend, behind the tool
//! permission system; no native capabilities are exposed to the webview.

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const BACKEND_ADDR: &str = "127.0.0.1:8765";

struct Backend(Mutex<Option<CommandChild>>);

fn backend_listening() -> bool {
    let addr: SocketAddr = BACKEND_ADDR.parse().expect("valid address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn start_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if backend_listening() {
        return Ok(()); // a backend is already running (development, or another instance)
    }
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let (mut events, child) = app
        .shell()
        .sidecar("jarvis-backend")?
        .env("JARVIS_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("JARVIS_HOST", "127.0.0.1")
        .env("JARVIS_PORT", "8765")
        // The backend exits by itself when this process is gone (closed, crashed or killed).
        .env("JARVIS_PARENT_PID", std::process::id().to_string())
        .spawn()?;
    app.manage(Backend(Mutex::new(Some(child))));
    // Drain the sidecar's output so its pipes never fill up.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let CommandEvent::Terminated(status) = event {
                eprintln!("jarvis-backend exited: {:?}", status.code);
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Err(err) = start_backend(app) {
                eprintln!("Couldn't start the JARVIS backend: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version])
        .build(tauri::generate_context!())
        .expect("error while building JARVIS desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Backend>() {
                    if let Some(child) = state.0.lock().expect("backend lock").take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
