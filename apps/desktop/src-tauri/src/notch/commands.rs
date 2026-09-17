// SPDX-License-Identifier: Apache-2.0
//! Comandos da Barra de IA chamados pela janela principal.
//!
//! A barra mora dentro do Cialai, entao a pagina cuida sozinha de desenho,
//! recolhimento e hover. Aqui ficam so os dados e as preferencias.

use tauri::{AppHandle, Emitter, State};

use crate::prefs::PrefsState;

use super::prefs::{NotchPreferences, NotchVisibility};
use super::{EVENT_OPEN_SETTINGS, NotchManager, NotchState};

#[tauri::command]
pub fn notch_state(notch: State<'_, NotchManager>) -> NotchState {
    notch.state()
}

/// Le o uso agora. Sem `profileId`, le todos os aneis.
#[tauri::command(async)]
pub fn notch_refresh(notch: State<'_, NotchManager>, profile_id: Option<String>) {
    notch.refresh(profile_id.as_deref());
}

/// Grava as preferencias da barra e aplica o que mudou.
#[tauri::command(async)]
pub fn notch_set_prefs(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    notch: State<'_, NotchManager>,
    next: NotchPreferences,
) -> Result<NotchPreferences, String> {
    let mut all = prefs.get();
    all.notch = next.clone();
    all.save(&app)?;
    prefs.set(all);
    notch.emit_prefs();
    // Ligar um perfil que estava desligado pede leitura, porque ele nunca foi
    // lido nesta sessao.
    notch.refresh(None);
    Ok(next)
}

/// Traz para a frente a sessao: o card do estudio quando ela roda aqui dentro,
/// senao o app dono do processo.
#[tauri::command(async)]
pub fn notch_focus_session(notch: State<'_, NotchManager>, session_id: String) -> bool {
    notch.focus_session(&session_id)
}

/// Abre as Preferencias na secao da barra.
#[tauri::command(async)]
pub fn notch_open_settings(app: AppHandle) -> Result<(), String> {
    app.emit(EVENT_OPEN_SETTINGS, ())
        .map_err(|error| error.to_string())
}

/// Aberta, recolhida ou escondida.
#[tauri::command(async)]
pub fn notch_set_visibility(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    notch: State<'_, NotchManager>,
    visibility: NotchVisibility,
) -> Result<NotchVisibility, String> {
    let mut all = prefs.get();
    all.notch.visibility = visibility;
    all.save(&app)?;
    prefs.set(all);
    notch.emit_prefs();
    Ok(visibility)
}
