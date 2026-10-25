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

/// O script do PowerShell em UTF-16LE e base64, como `-EncodedCommand` pede.
fn encoded_powershell() -> String {
    let bytes: Vec<u8> = AGENTS_PS1
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
        dir.canonicalize().unwrap()
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
        assert_eq!(String::from_utf16(&units).unwrap(), AGENTS_PS1);

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
}
