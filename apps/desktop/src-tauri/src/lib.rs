// SPDX-License-Identifier: Apache-2.0
//! Cialai desktop application shell.

/// Builds and runs the platform shell. Product commands are added by the next
/// extraction tasks; keeping this entry real makes every scaffold check exercise
/// the same Tauri configuration that will package the studio.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("failed to run Cialai desktop");
}
