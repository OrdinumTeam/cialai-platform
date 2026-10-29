// SPDX-License-Identifier: Apache-2.0
//! Menu de contas ao digitar `codex` ou `claude` nas sessoes do Cialai.
//!
//! Quando o mesmo agente tem mais de um perfil, o shell de uma sessao do
//! Cialai pergunta qual conta usar, com a cota de cada uma, antes de abrir o
//! agente. Enter repete a ultima conta usada na pasta, um numero troca, a
//! conta esgotada fica para tras e `codex +nome` escolhe direto. A conta
//! escolhida na interface para os terminais novos continua valendo: um
//! perfil nomeado ja vem no ambiente do shell, e ai o menu nao aparece. Tres
//! pecas:
//!
//! - [`install`] grava em `~/.cialai/shell` os scripts de `agent_menu/`: o
//!   menu para zsh, bash e PowerShell e os arquivos de inicializacao que
//!   carregam os do usuario antes dele.
//! - [`injection`] diz como o shell da sessao nasce para carregar o menu
//!   depois dos arquivos do usuario: `ZDOTDIR` no zsh, `--init-file` no bash
//!   e `-NoExit -EncodedCommand` no PowerShell, que nao depende da politica
//!   de execucao. So vale com os argumentos padrao: um shell com argumentos
//!   proprios nas preferencias nasce como sempre, assim como fish, cmd e os
//!   outros. `CIALAI_AGENT_MENU=0` no ambiente do app desliga a injecao.
//! - [`publish`] grava em `~/.cialai/agents` as contas de cada agente com a
//!   cota ja traduzida pela interface. A interface manda so o id de cada
//!   conta; a pasta sai de [`super::agent_profiles`], a partir da pasta
//!   pessoal, nunca do que a interface manda.
//!
//! O script pula o menu quando a pasta do perfil ja vem no ambiente, sem
//! terminal, em `--version` e `--help`, no login e na retomada com id, que e
//! o que [`super::resume`] digita ao reabrir uma conversa.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;

use crate::i18n::t;
use crate::platform::ShellSpec;

use super::agent_profiles::{self, Agent};

/// Pasta dos scripts, relativa a pasta pessoal.
pub const SHELL_DIR: &str = ".cialai/shell";
/// Pasta das contas publicadas e da ultima conta por pasta.
pub const AGENTS_DIR: &str = ".cialai/agents";
/// Variavel do ambiente do app que desliga o menu com o valor `0`.
pub const SWITCH: &str = "CIALAI_AGENT_MENU";

const AGENTS_PS1: &str = include_str!("agent_menu/agents.ps1");
const FILES: &[(&str, &str)] = &[
    ("agents.zsh", include_str!("agent_menu/agents.zsh")),
    ("agents.bash", include_str!("agent_menu/agents.bash")),
    ("agents.ps1", AGENTS_PS1),
    ("zsh/.zshenv", include_str!("agent_menu/zshenv.zsh")),
    ("zsh/.zprofile", include_str!("agent_menu/zprofile.zsh")),
    ("zsh/.zshrc", include_str!("agent_menu/zshrc.zsh")),
    ("zsh/.zlogin", include_str!("agent_menu/zlogin.zsh")),
    ("bash/init.bash", include_str!("agent_menu/init.bash")),
];
const STATES: &[&str] = &["free", "out", "unknown", "none"];

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

/// Grava os scripts que mudaram e devolve a pasta deles.
pub fn install(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join(SHELL_DIR);
    for (name, contents) in FILES {
        write_if_changed(&dir.join(name), contents)?;
    }
    Ok(dir)
}

/// Argumentos e variaveis com que o shell da sessao nasce para ter o menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Injection {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn shell_name(path: &str) -> String {
    let name = path
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

/// O script do PowerShell sem as linhas de comentario e sem recuo. A linha de
/// comando do Windows tem limite de 32 mil caracteres, e o base64 do UTF-16
/// quase triplica o texto. O script nao tem texto de varias linhas, entao
/// tirar o recuo nao muda o que ele faz.
fn compact_powershell() -> String {
    AGENTS_PS1
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// O script do PowerShell em UTF-16LE e base64, como `-EncodedCommand` pede.
fn encoded_powershell() -> String {
    let bytes: Vec<u8> = compact_powershell()
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Como o shell nasce com o menu, ou `None` para nascer como sempre.
/// `user_zdotdir` e o `ZDOTDIR` que o app herdou, devolvido ao zsh depois.
pub fn injection(
    shell: &ShellSpec,
    default_args: bool,
    shell_dir: &Path,
    user_zdotdir: Option<&str>,
) -> Option<Injection> {
    if !default_args {
        return None;
    }
    let portable = |path: PathBuf| crate::platform::to_portable(path);
    match shell_name(&shell.path).as_str() {
        "zsh" => {
            let mut env = vec![("ZDOTDIR".to_string(), portable(shell_dir.join("zsh")))];
            if let Some(dir) = user_zdotdir.filter(|dir| !dir.trim().is_empty()) {
                env.push(("CIALAI_USER_ZDOTDIR".to_string(), dir.to_string()));
            }
            Some(Injection {
                args: shell.args.clone(),
                env,
            })
        }
        "bash" => {
            let login = shell.args.iter().any(|arg| arg == "-l" || arg == "--login");
            Some(Injection {
                args: vec![
                    "--init-file".to_string(),
                    portable(shell_dir.join("bash").join("init.bash")),
                ],
                env: if login {
                    vec![("CIALAI_BASH_LOGIN".to_string(), "1".to_string())]
                } else {
                    Vec::new()
                },
            })
        }
        "pwsh" | "powershell" => {
            let mut args = shell.args.clone();
            args.extend([
                "-NoExit".to_string(),
                "-EncodedCommand".to_string(),
                encoded_powershell(),
            ]);
            Some(Injection {
                args,
                env: Vec::new(),
            })
        }
        _ => None,
    }
}

/// Injecao para uma sessao nova: respeita [`SWITCH`] e grava os scripts.
/// Um erro ao gravar faz o shell nascer como sempre.
pub fn for_session(shell: &ShellSpec, default_args: bool, home: &Path) -> Option<Injection> {
    if std::env::var(SWITCH).is_ok_and(|value| value.trim() == "0") {
        return None;
    }
    let dir = install(home).ok()?;
    let user_zdotdir = std::env::var("ZDOTDIR").ok();
    injection(shell, default_args, &dir, user_zdotdir.as_deref())
}

/// Linha de uma conta como a interface mostra: o perfil vem pelo id, o mesmo
/// de `agent_profiles`, como `codex` ou `codex-felipe`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuEntry {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub detail: String,
}

/// Textos do menu no idioma da interface. `{name}` vira o nome da conta.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuStrings {
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub enter: String,
    #[serde(default)]
    pub missing: String,
}

/// Um campo do arquivo: sem tab, quebra de linha ou sequencia de controle,
/// que o script imprime no terminal, e com `-` no lugar do vazio, porque o
/// `read` do shell junta tabs seguidos.
fn field(value: &str) -> String {
    let clean: String = value
        .chars()
        .map(|char| if char.is_control() { ' ' } else { char })
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        "-".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Grava as contas do agente e os textos do menu, so quando mudaram.
///
/// As contas ficam na ordem em que a interface mandou, que e a da lista. Um
/// id que nao vira pasta de perfil do agente, ou que se repete, fica de fora.
/// A conferencia e a dos marcadores, sem consultar o chaveiro: a lista ja
/// passou pela descoberta completa antes de chegar aqui.
pub fn publish(
    home: &Path,
    agent: &str,
    entries: &[MenuEntry],
    strings: &MenuStrings,
) -> Result<(), String> {
    let kind = Agent::parse(agent).ok_or_else(|| t("native.error.agentUnknown"))?;
    let mut seen: Vec<&str> = Vec::new();
    let mut lines = String::new();
    for entry in entries {
        if seen.contains(&entry.id.as_str()) {
            continue;
        }
        let Some(slug) = agent_profiles::slug_of(kind, &entry.id) else {
            continue;
        };
        let Some(dir) = agent_profiles::dir_of(home, kind, &entry.id)
            .filter(|dir| agent_profiles::is_profile_dir(dir, kind))
        else {
            continue;
        };
        seen.push(&entry.id);
        // A pasta "-" e o perfil padrao, que o script roda sem a variavel.
        let (name, folder) = match slug {
            None => ("-".to_string(), "-".to_string()),
            Some(name) => (name.to_string(), crate::platform::to_portable(&dir)),
        };
        let label = if entry.label.trim().is_empty() {
            slug.unwrap_or(kind.as_str())
        } else {
            entry.label.as_str()
        };
        let state = if STATES.contains(&entry.state.as_str()) {
            entry.state.as_str()
        } else {
            "unknown"
        };
        let row = [
            name.as_str(),
            label,
            folder.as_str(),
            state,
            &entry.value,
            &entry.detail,
        ]
        .iter()
        .map(|value| field(value))
        .collect::<Vec<_>>()
        .join("\t");
        lines.push_str(&row);
        lines.push('\n');
    }
    let dir = home.join(AGENTS_DIR);
    write_if_changed(&dir.join(format!("{}.tsv", kind.as_str())), &lines)?;
    let menu = format!(
        "question\t{}\nenter\t{}\nmissing\t{}\n",
        field(&strings.question),
        field(&strings.enter),
        field(&strings.missing)
    );
    write_if_changed(&dir.join("menu.tsv"), &menu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-agent-menu-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn spec(path: &str, args: &[&str]) -> ShellSpec {
        ShellSpec::new(
            path.to_string(),
            args.iter().map(|arg| arg.to_string()).collect(),
        )
    }

    #[test]
    fn each_shell_gets_the_menu_after_its_own_startup_files() {
        let dir = Path::new("/h/.cialai/shell");
        let zsh = injection(
            &spec("/bin/zsh", &["-l"]),
            true,
            dir,
            Some("/h/.config/zsh"),
        )
        .unwrap();
        assert_eq!(zsh.args, vec!["-l"]);
        assert_eq!(
            zsh.env,
            vec![
                ("ZDOTDIR".to_string(), "/h/.cialai/shell/zsh".to_string()),
                (
                    "CIALAI_USER_ZDOTDIR".to_string(),
                    "/h/.config/zsh".to_string()
                ),
            ]
        );
        assert_eq!(
            injection(&spec("/bin/zsh", &["-l"]), true, dir, Some(" "))
                .unwrap()
                .env
                .len(),
            1
        );

        let bash = injection(&spec("/usr/bin/bash", &["-l"]), true, dir, None).unwrap();
        assert_eq!(
            bash.args,
            vec!["--init-file", "/h/.cialai/shell/bash/init.bash"]
        );
        assert_eq!(
            bash.env,
            vec![("CIALAI_BASH_LOGIN".to_string(), "1".to_string())]
        );
        assert!(
            injection(&spec("bash", &[]), true, dir, None)
                .unwrap()
                .env
                .is_empty()
        );

        let pwsh = injection(
            &spec("C:/Program Files/PowerShell/7/pwsh.exe", &["-NoLogo"]),
            true,
            dir,
            None,
        )
        .unwrap();
        assert_eq!(&pwsh.args[..3], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
        assert!(
            pwsh.args[3].len() < 30_000,
            "a linha de comando do Windows tem limite"
        );
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&pwsh.args[3])
            .unwrap();
        let units: Vec<u16> = decoded
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), compact_powershell());
        assert!(
            !AGENTS_PS1.contains("@'") && !AGENTS_PS1.contains("@\""),
            "texto de varias linhas perderia o recuo"
        );

        for other in [
            "/usr/bin/fish",
            "C:/Windows/System32/cmd.exe",
            "/bin/sh",
            "nu",
        ] {
            assert_eq!(
                injection(&spec(other, &[]), true, dir, None),
                None,
                "{other}"
            );
        }
        assert_eq!(
            injection(&spec("/bin/zsh", &["-i"]), false, dir, None),
            None,
            "argumentos proprios"
        );
    }

    #[test]
    fn install_writes_the_scripts_once() {
        let home = scratch("install");
        let dir = install(&home).unwrap();
        assert_eq!(dir, home.join(SHELL_DIR));
        for (name, contents) in FILES {
            assert_eq!(
                &fs::read_to_string(dir.join(name)).unwrap(),
                contents,
                "{name}"
            );
        }
        let zshrc = dir.join("zsh/.zshrc");
        let before = fs::metadata(&zshrc).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        install(&home).unwrap();
        assert_eq!(fs::metadata(&zshrc).unwrap().modified().unwrap(), before);
        fs::remove_dir_all(&home).unwrap();
    }

    /// Pasta de perfil do Codex com o marcador que a descoberta exige.
    fn codex_profile(home: &Path, folder: &str) {
        fs::create_dir_all(home.join(folder)).unwrap();
        fs::write(home.join(folder).join("config.toml"), "").unwrap();
    }

    #[test]
    fn publish_takes_the_folders_from_discovery_and_cleans_the_text() {
        let home = scratch("publish");
        codex_profile(&home, ".codex");
        codex_profile(&home, ".codex-felipe");
        // Pasta sem marcador nao e perfil, mesmo com o nome certo.
        fs::create_dir_all(home.join(".codex-vazio")).unwrap();
        let entries = vec![
            MenuEntry {
                id: "codex".into(),
                label: "padrão".into(),
                state: "free".into(),
                value: "62%".into(),
                detail: "renova 14:00".into(),
            },
            MenuEntry {
                id: "codex-felipe".into(),
                label: "fel\tipe\u{1b}[31m".into(),
                state: "rm -rf".into(),
                value: String::new(),
                detail: String::new(),
            },
            MenuEntry {
                id: "codex-felipe".into(),
                label: "repetido".into(),
                ..MenuEntry::default()
            },
            MenuEntry {
                id: "codex-intruso".into(),
                label: "x".into(),
                ..MenuEntry::default()
            },
            MenuEntry {
                id: "codex-vazio".into(),
                ..MenuEntry::default()
            },
            MenuEntry {
                id: "codex-../fuga".into(),
                ..MenuEntry::default()
            },
            MenuEntry {
                id: "claude".into(),
                ..MenuEntry::default()
            },
        ];
        let strings = MenuStrings {
            question: "Qual conta?".into(),
            enter: "Enter usa {name}".into(),
            missing: "Nenhuma conta {name}".into(),
        };
        publish(&home, "codex", &entries, &strings).unwrap();
        let felipe = crate::platform::to_portable(home.join(".codex-felipe"));
        assert_eq!(
            fs::read_to_string(home.join(".cialai/agents/codex.tsv")).unwrap(),
            format!(
                "-\tpadrão\t-\tfree\t62%\trenova 14:00\nfelipe\tfel ipe [31m\t{felipe}\tunknown\t-\t-\n"
            )
        );
        assert_eq!(
            fs::read_to_string(home.join(".cialai/agents/menu.tsv")).unwrap(),
            "question\tQual conta?\nenter\tEnter usa {name}\nmissing\tNenhuma conta {name}\n"
        );
        assert_eq!(
            publish(&home, "gemini", &entries, &strings).unwrap_err(),
            t("native.error.agentUnknown")
        );
        fs::remove_dir_all(&home).unwrap();
    }

    /// O menu de verdade no zsh e no bash: um `codex` falso imprime a pasta
    /// que recebeu, sem terminal e com `+nome`.
    #[cfg(unix)]
    #[test]
    fn the_shell_scripts_pick_the_account_folder() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch("shells");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("codex");
        fs::write(
            &fake,
            "#!/bin/sh\necho \"${CODEX_HOME-unset}|${CODEX_PROFILE-unset}|$*\"\n",
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        codex_profile(&home, ".codex");
        codex_profile(&home, ".codex-felipe");
        let entries = vec![
            MenuEntry {
                id: "codex".into(),
                label: "padrão".into(),
                state: "free".into(),
                ..MenuEntry::default()
            },
            MenuEntry {
                id: "codex-felipe".into(),
                label: "felipe".into(),
                state: "free".into(),
                ..MenuEntry::default()
            },
        ];
        publish(&home, "codex", &entries, &MenuStrings::default()).unwrap();
        let dir = install(&home).unwrap();
        let felipe = crate::platform::to_portable(home.join(".codex-felipe"));
        let path = format!("{}:/usr/bin:/bin", bin.display());
        for (shell, script, flags) in [("zsh", "agents.zsh", "-fc"), ("bash", "agents.bash", "-c")]
        {
            if Command::new(shell).arg("-c").arg("true").output().is_err() {
                continue;
            }
            let run = |line: &str| {
                let output = Command::new(shell)
                    .arg(flags)
                    .arg(format!("source '{}'; {line}", dir.join(script).display()))
                    .env_clear()
                    .env("HOME", &home)
                    .env("PATH", &path)
                    .current_dir(&home)
                    .stdin(std::process::Stdio::null())
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            };
            assert_eq!(
                run("codex +felipe exec x"),
                format!("{felipe}|felipe|exec x"),
                "{shell}"
            );
            assert_eq!(run("codex +padrão"), "unset|unset|", "{shell}");
            assert_eq!(
                run("codex hello"),
                "unset|unset|hello",
                "{shell} sem terminal"
            );
            assert_eq!(
                run("CODEX_HOME=/e codex +felipe"),
                format!("{felipe}|felipe|"),
                "{shell}"
            );
            assert_eq!(
                run("function codex_user { :; }; codex +ninguem; echo $?"),
                "2",
                "{shell}"
            );
            // O login nunca pergunta a conta: o app ja digita a pasta dele.
            assert_eq!(
                run("_cialai_agents_skip codex login; echo $?"),
                "0",
                "{shell}"
            );
            assert_eq!(
                run("_cialai_agents_skip claude auth login; echo $?"),
                "0",
                "{shell}"
            );
            assert_eq!(
                run("_cialai_agents_skip codex exec x; echo $?"),
                "1",
                "{shell}"
            );
        }
        fs::remove_dir_all(&home).unwrap();
    }

    /// Terminal de verdade para dirigir o menu: um PTY com o shell, a saida
    /// lida numa thread e as teclas escritas como o xterm do app escreve.
    struct Tty {
        writer: std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        output: std::sync::Arc<std::sync::Mutex<String>>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        _master: Box<dyn portable_pty::MasterPty + Send>,
        seen: usize,
        last_command: String,
        /// Fim do prompt que o shell mostra antes de aceitar a proxima linha.
        /// O PSReadLine so trata o Enter como Enter depois de abrir o prompt;
        /// antes disso o terminal ainda converte o Enter em quebra de linha. O
        /// espaco depois do `>` do PowerShell e um `ESC[1C`, nao um espaco, por
        /// isso o fim do prompt e o nome da pasta da sessao mais `>`.
        /// No Unix o prompt ainda pode preceder o modo raw do PSReadLine.
        prompt: Option<String>,
    }

    /// Tira as sequencias de controle, que o ConPTY do Windows espalha pela
    /// saida ao redesenhar a tela.
    fn plain(text: &str) -> String {
        let mut out = String::new();
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\u{1b}' {
                if c != '\r' {
                    out.push(c);
                }
                continue;
            }
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.peek() == Some(&'\\')) {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }

    impl Tty {
        fn open(program: &str, args: &[&str], home: &Path, path: &str) -> Option<Self> {
            use std::io::Read;
            let pair = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize {
                    rows: 40,
                    cols: 140,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .ok()?;
            let mut command = portable_pty::CommandBuilder::new(program);
            command.args(args);
            // Windows PowerShell relies on the OS runtime/module environment.
            // Keep that environment as the app does, while isolating the home,
            // profiles and selected agents below. Unix needs only the fixture.
            #[cfg(unix)]
            command.env_clear();
            for key in [
                "CODEX_HOME",
                "CODEX_PROFILE",
                "CLAUDE_CONFIG_DIR",
                "CLAUDE_PROFILE",
                "CIALAI_AGENT_MENU",
                "CIALAI_USER_ZDOTDIR",
            ] {
                command.env_remove(key);
            }
            command.env("HOME", home);
            command.env("USERPROFILE", home);
            command.env("PATH", path);
            command.env("TERM", "xterm-256color");
            command.env("CIALAI_AGENTS_DIR", home.join(".cialai").join("agents"));
            let locale = if cfg!(target_os = "macos") {
                "en_US.UTF-8"
            } else {
                "C.UTF-8"
            };
            command.env("LANG", locale);
            command.env("LC_ALL", locale);
            for key in [
                "SystemRoot",
                "SYSTEMROOT",
                "windir",
                "ComSpec",
                "PATHEXT",
                "TEMP",
                "TMP",
                "LOCALAPPDATA",
                "APPDATA",
            ] {
                if let Ok(value) = std::env::var(key) {
                    command.env(key, value);
                }
            }
            command.cwd(home);
            let child = pair.slave.spawn_command(command).ok()?;
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().ok()?;
            let writer =
                std::sync::Arc::new(std::sync::Mutex::new(pair.master.take_writer().ok()?));
            let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let sink = output.clone();
            let answer = writer.clone();
            std::thread::spawn(move || {
                // O PSReadLine e o ConPTY perguntam onde esta o cursor e esperam
                // a resposta; o xterm do app responde, e aqui o leitor responde.
                let mut buffer = [0u8; 8192];
                let mut tail: Vec<u8> = Vec::new();
                while let Ok(read) = reader.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    let mut window = std::mem::take(&mut tail);
                    window.extend_from_slice(&buffer[..read]);
                    let asked = window.windows(4).filter(|part| *part == b"\x1b[6n").count();
                    for _ in 0..asked {
                        let mut writer = answer.lock().unwrap();
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    tail = window[window.len().saturating_sub(3)..].to_vec();
                    sink.lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(&buffer[..read]));
                }
            });
            Some(Self {
                writer,
                output,
                child,
                _master: pair.master,
                seen: 0,
                last_command: String::new(),
                prompt: None,
            })
        }

        /// Digita uma linha de comando, depois do prompt quando o shell pede.
        fn command(&mut self, line: &str) {
            self.last_command = line.to_owned();
            if let Some(prompt) = self.prompt.clone() {
                self.wait(&prompt);
                self.wait_for_input_mode();
            }
            self.send(format!("{line}\r").as_bytes());
        }

        /// Printing the prompt does not guarantee ReadKey is ready yet.
        /// Observe the PTY input mode instead of sleeping or changing it.
        fn wait_for_input_mode(&self) {
            #[cfg(unix)]
            {
                let fd = self._master.as_raw_fd().expect("fixture PTY fd");
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                loop {
                    let mut mode = std::mem::MaybeUninit::<libc::termios>::uninit();
                    // SAFETY: fd belongs to the live master and mode is writable.
                    assert_eq!(unsafe { libc::tcgetattr(fd, mode.as_mut_ptr()) }, 0);
                    // SAFETY: tcgetattr initialized mode on success above.
                    let mode = unsafe { mode.assume_init() };
                    if mode.c_lflag & (libc::ICANON | libc::ECHO) == 0
                        && mode.c_iflag & libc::ICRNL == 0
                    {
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "fixture prompt appeared before raw input: iflag={} lflag={}",
                        mode.c_iflag,
                        mode.c_lflag
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }

        fn send(&mut self, bytes: &[u8]) {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(bytes).unwrap();
            writer.flush().unwrap();
        }

        /// Espera `needle` depois do ultimo ponto lido e devolve o que veio ate
        /// ele, ja sem as sequencias de controle.
        fn wait(&mut self, needle: &str) -> String {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                {
                    let text = plain(&self.output.lock().unwrap());
                    if let Some(at) = text.get(self.seen..).and_then(|rest| rest.find(needle)) {
                        let end = self.seen + at + needle.len();
                        let chunk = text[self.seen..end].to_string();
                        self.seen = end;
                        return chunk;
                    }
                    if std::time::Instant::now() > deadline {
                        panic!(
                            "esperando {needle:?} para {:?}; offset {}; veio:\n{}\ntranscricao crua: {:?}",
                            self.last_command,
                            self.seen,
                            text.get(self.seen..).unwrap_or(""),
                            self.output.lock().unwrap()
                        );
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }

        /// O resto da linha depois de `marker`.
        fn value(&mut self, marker: &str) -> String {
            self.wait(marker);
            self.wait("\n").trim().to_string()
        }
    }

    impl Drop for Tty {
        fn drop(&mut self) {
            let _ = self.child.kill();
        }
    }

    /// Resultado de uma rodada do `codex` falso: campo por campo.
    fn fields(line: &str) -> std::collections::HashMap<String, String> {
        line.split_whitespace()
            .filter_map(|pair| pair.split_once('='))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    /// Tres contas do Codex, a padrao esgotada, publicadas como o app publica.
    fn three_accounts(home: &Path) {
        codex_profile(home, ".codex");
        codex_profile(home, ".codex-felipe");
        codex_profile(home, ".codex-time_b");
        let entry = |id: &str, label: &str, state: &str| MenuEntry {
            id: id.into(),
            label: label.into(),
            state: state.into(),
            ..MenuEntry::default()
        };
        let strings = MenuStrings {
            question: "Qual conta?".into(),
            enter: "↑ ↓, Enter usa {name}".into(),
            missing: "Nenhuma conta {name}".into(),
        };
        publish(
            home,
            "codex",
            &[
                entry("codex", "padrão", "out"),
                entry("codex-felipe", "felipe", "free"),
                entry("codex-time_b", "time_b", "free"),
            ],
            &strings,
        )
        .unwrap();
    }

    /// Uma rodada: digita `codex`, espera o menu, aperta as teclas e devolve o
    /// que o agente falso recebeu.
    fn round(
        tty: &mut Tty,
        enter: &str,
        keys: &[&[u8]],
    ) -> Option<std::collections::HashMap<String, String>> {
        let _ = enter;
        tty.command("codex marca");
        tty.wait("Qual conta?");
        tty.wait("Enter usa");
        for key in keys {
            std::thread::sleep(std::time::Duration::from_millis(120));
            tty.send(key);
        }
        Some(fields(&tty.value("RESULT ")))
    }

    /// O menu de verdade no zsh e no bash, num terminal de verdade: setas,
    /// j e k, numero, Enter, Esc, a conta esgotada pulada, a ultima conta da
    /// pasta lembrada e o agente rodando no proprio shell, como lider do
    /// proprio grupo, que e o que o card do Cialai le.
    #[cfg(unix)]
    #[test]
    fn the_account_menu_is_driven_by_arrows_in_a_real_terminal() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch("tty");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("codex");
        fs::write(
            &fake,
            "#!/bin/sh\nprintf 'RESULT home=%s profile=%s args=%s ppid=%s pgid=%s pid=%s\\n' \"${CODEX_HOME-unset}\" \"${CODEX_PROFILE-unset}\" \"$(echo $* | tr ' ' ,)\" \"$PPID\" \"$(ps -o pgid= -p $$ | tr -d ' ')\" \"$$\"\n",
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        three_accounts(&home);
        let dir = install(&home).unwrap();
        let folder = |name: &str| crate::platform::to_portable(home.join(name));
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let mut ran = Vec::new();
        for (shell, args, script) in [
            ("zsh", vec!["-f", "-i"], "agents.zsh"),
            ("bash", vec!["--norc", "--noprofile", "-i"], "agents.bash"),
        ] {
            if Command::new(shell).arg("-c").arg("true").output().is_err() {
                continue;
            }
            let mut tty = Tty::open(shell, &args, &home, &path).expect(shell);
            tty.send(
                format!(
                    "source '{}'; echo READY$((40+2))\r",
                    dir.join(script).display()
                )
                .as_bytes(),
            );
            tty.wait("READY42");
            tty.send(b"echo SHELL$((40+2))=$$\r");
            let shell_pid = tty.value("SHELL42=");
            let forget = |tty: &mut Tty| {
                tty.send(b"rm -f \"$HOME/.cialai/agents/codex.last\"; echo CLEAN$((40+2))\r");
                tty.wait("CLEAN42");
            };
            let check = |got: Option<std::collections::HashMap<String, String>>,
                         home_dir: &str,
                         profile: &str,
                         what: &str| {
                let got = got.unwrap_or_else(|| panic!("{shell} {what}: o menu desistiu"));
                assert_eq!(got["home"], home_dir, "{shell} {what}");
                assert_eq!(got["profile"], profile, "{shell} {what}");
                assert_eq!(
                    got["args"], "marca",
                    "{shell} {what}: os argumentos chegam ao agente"
                );
                assert_eq!(
                    got["ppid"], shell_pid,
                    "{shell} {what}: o agente roda no proprio shell, sem subshell"
                );
                assert_eq!(
                    got["pgid"], got["pid"],
                    "{shell} {what}: o agente lidera o grupo em primeiro plano"
                );
            };

            // A padrao esgotada fica para tras: Enter abre a seguinte com cota.
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\r"]),
                &folder(".codex-felipe"),
                "felipe",
                "Enter",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1b[B", b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "seta para baixo",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1b[A", b"\r"]),
                "unset",
                "unset",
                "seta para cima, na padrao",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1b[B", b"\x1b[B", b"\r"]),
                "unset",
                "unset",
                "a seta da volta",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1bOB", b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "modo de aplicacao do cursor",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"j", b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "j",
            );
            forget(&mut tty);
            check(round(&mut tty, "\r", &[b"k", b"\r"]), "unset", "unset", "k");
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1b[1;5A", b"\r"]),
                "unset",
                "unset",
                "Ctrl+seta nao vira numero",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"3"]),
                &folder(".codex-time_b"),
                "time_b",
                "numero abre direto",
            );

            // A ultima conta usada na pasta volta marcada.
            check(
                round(&mut tty, "\r", &[b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "a ultima da pasta",
            );

            // Esc desiste, o agente nao roda e o shell devolve 130.
            forget(&mut tty);
            tty.send(b"codex marca; echo CANCELADO$((40+2))=$?\r");
            tty.wait("Qual conta?");
            tty.wait("Enter usa");
            std::thread::sleep(std::time::Duration::from_millis(150));
            tty.send(b"\x1b");
            let status = tty.value("CANCELADO42=");
            assert_eq!(status, "130", "{shell} Esc");
            tty.send(b"echo AFTER$((40+2))=${CODEX_HOME-unset},${CODEX_PROFILE-unset}\r");
            assert_eq!(
                tty.value("AFTER42="),
                "unset,unset",
                "{shell}: a conta nao fica no shell depois do agente"
            );

            // Uma funcao do usuario com o mesmo nome roda depois do menu, com a conta.
            tty.send(
                b"_cialai_user_codex() { command codex embrulho \"$@\"; }; echo WRAP$((40+2))\r",
            );
            tty.wait("WRAP42");
            forget(&mut tty);
            tty.send(b"codex marca\r");
            tty.wait("Enter usa");
            std::thread::sleep(std::time::Duration::from_millis(120));
            tty.send(b"\r");
            let line = tty.value("RESULT ");
            let got = fields(&line);
            assert_eq!(
                got["home"],
                folder(".codex-felipe"),
                "{shell} funcao do usuario"
            );
            assert_eq!(got["args"], "embrulho,marca", "{shell} funcao do usuario");
            ran.push(shell);
        }
        assert!(!ran.is_empty(), "nenhum shell para testar");
        fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn fixture_waits_for_raw_input_after_the_prompt() {
        let home = scratch("tty-readiness");
        // Model the interval between PowerShell printing its prompt and
        // PSReadLine switching input out of canonical mode. An early CR
        // becomes LF, which ReadKey does not accept as Enter.
        let source = "import os,time,tty; print('FIXTURE>',flush=True); time.sleep(0.4); tty.setraw(0); data=os.read(0,6); print('RESULT='+data.hex(),flush=True); time.sleep(0.1)";
        let path = std::env::var("PATH").unwrap_or_default();
        let mut terminal = Tty::open("python3", &["-u", "-c", source], &home, &path).unwrap();
        terminal.prompt = Some("FIXTURE>".into());
        terminal.command("probe");
        let output = terminal.wait("RESULT=70726f62650d");
        assert!(output.contains("RESULT=70726f62650d"));
        drop(terminal);
        fs::remove_dir_all(home).unwrap();
    }

    /// O mesmo menu no PowerShell, quando ele existe: o pwsh no Linux e no
    /// macOS, e o Windows PowerShell e o pwsh no Windows, pelo ConPTY.
    #[test]
    fn the_powershell_menu_is_driven_by_arrows_in_a_real_terminal() {
        let home = scratch("tty-ps");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let fake = bin.join("codex");
            fs::write(
                &fake,
                "#!/bin/sh\nprintf 'RESULT home=%s profile=%s args=%s ppid=%s\\n' \"${CODEX_HOME-unset}\" \"${CODEX_PROFILE-unset}\" \"$(echo $* | tr ' ' ,)\" \"$PPID\"\n",
            )
            .unwrap();
            fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        fs::write(
            bin.join("codex.cmd"),
            "@echo off\r\nif defined CODEX_HOME (set H=%CODEX_HOME%) else (set H=unset)\r\nif defined CODEX_PROFILE (set P=%CODEX_PROFILE%) else (set P=unset)\r\nset A=%*\r\nset A=%A: =,%\r\necho RESULT home=%H% profile=%P% args=%A%\r\n",
        )
        .unwrap();
        three_accounts(&home);
        let dir = install(&home).unwrap();
        let folder = |name: &str| crate::platform::to_portable(home.join(name));
        let separator = if cfg!(windows) { ";" } else { ":" };
        let system = std::env::var("PATH").unwrap_or_default();
        let path = format!("{}{separator}{system}", bin.display());
        let mut ran = Vec::new();
        let candidates: &[&str] = if cfg!(windows) {
            &["powershell.exe", "pwsh.exe"]
        } else {
            &["pwsh"]
        };
        for program in candidates {
            if Command::new(program)
                .args(["-NoLogo", "-NoProfile", "-Command", "exit 0"])
                .output()
                .is_err()
            {
                continue;
            }
            // Como o app abre o PowerShell: -NoExit e o script compacto em -EncodedCommand.
            let injected = injection(&spec(program, &["-NoLogo", "-NoProfile"]), true, &dir, None)
                .expect("injecao do PowerShell");
            let args: Vec<&str> = injected.args.iter().map(String::as_str).collect();
            let mut tty = Tty::open(program, &args, &home, &path).expect(program);
            tty.prompt = Some(format!("{}>", home.file_name().unwrap().to_string_lossy()));
            tty.command("Write-Output ('READY' + (40+2))");
            tty.wait("READY42");
            tty.command("Write-Output ('SHELL' + (40+2) + '=' + $PID)");
            let shell_pid = tty.value("SHELL42=");
            let forget = |tty: &mut Tty| {
                tty.command("Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $global:CialaiAgentsDir 'codex.last'); Write-Output ('CLEAN' + (40+2))");
                tty.wait("CLEAN42");
            };
            let check = |got: Option<std::collections::HashMap<String, String>>,
                         home_dir: &str,
                         profile: &str,
                         what: &str| {
                let got = got.unwrap_or_else(|| panic!("{program} {what}: o menu desistiu"));
                assert_eq!(
                    got["home"].replace('\\', "/"),
                    home_dir.replace('\\', "/"),
                    "{program} {what}"
                );
                assert_eq!(got["profile"], profile, "{program} {what}");
                assert_eq!(got["args"], "marca", "{program} {what}");
                if let Some(ppid) = got.get("ppid") {
                    assert_eq!(
                        ppid, &shell_pid,
                        "{program} {what}: o agente e filho do PowerShell"
                    );
                }
            };
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\r"]),
                &folder(".codex-felipe"),
                "felipe",
                "Enter",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1b[B", b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "seta para baixo",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"\x1b[A", b"\r"]),
                "unset",
                "unset",
                "seta para cima, na padrao",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"j", b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "j",
            );
            forget(&mut tty);
            check(
                round(&mut tty, "\r", &[b"3"]),
                &folder(".codex-time_b"),
                "time_b",
                "numero abre direto",
            );
            check(
                round(&mut tty, "\r", &[b"\r"]),
                &folder(".codex-time_b"),
                "time_b",
                "a ultima da pasta",
            );
            forget(&mut tty);
            tty.command("codex marca; Write-Output ('CANCELADO' + (40+2) + '=' + $LASTEXITCODE)");
            tty.wait("Qual conta?");
            tty.wait("Enter usa");
            std::thread::sleep(std::time::Duration::from_millis(150));
            tty.send(b"\x1b");
            assert_eq!(tty.value("CANCELADO42="), "130", "{program} Esc");
            tty.command("Write-Output ('AFTER' + (40+2) + '=' + [string]$env:CODEX_HOME + ',' + [string]$env:CODEX_PROFILE)");
            assert_eq!(
                tty.value("AFTER42="),
                ",",
                "{program}: a conta nao fica no shell depois do agente"
            );
            ran.push(*program);
        }
        if ran.is_empty() {
            eprintln!("sem PowerShell neste sistema; o teste nao rodou");
        }
        let _ = fs::remove_dir_all(&home);
    }
}
