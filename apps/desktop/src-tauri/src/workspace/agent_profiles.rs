// SPDX-License-Identifier: Apache-2.0
//! Conta que cada agente usa, escolhida pela interface em vez de digitada no
//! terminal.
//!
//! Uma conta e uma pasta de configuracao: `~/.claude` e `~/.claude-<nome>`
//! para o Claude Code, `~/.codex` e `~/.codex-<nome>` para o Codex. O Cialai
//! **so escolhe qual pasta o agente vai usar**: nunca troca `auth.json` de
//! lugar, nunca copia credencial e nunca le o conteudo de arquivo de
//! credencial nenhum.
//!
//! O cliente tambem nunca envia variavel de ambiente nem caminho. Ele manda o
//! id do perfil; o servidor resolve a pasta a partir da propria pasta pessoal,
//! confere os marcadores e decide o ambiente do shell.

use std::path::{Path, PathBuf};

/// Marcadores que provam que uma pasta e mesmo um perfil do Claude Code, e nao
/// um plugin qualquer com nome parecido.
pub const CLAUDE_MARKERS: &[&str] = &[
    "sessions",
    "projects",
    "settings.json",
    "history.jsonl",
    ".claude.json",
];
/// O mesmo para o Codex.
pub const CODEX_MARKERS: &[&str] = &[
    "auth.json",
    "config.toml",
    "sessions",
    "history.jsonl",
    "state_5.sqlite",
];

/// Maior nome de perfil aceito na criacao.
pub const NAME_LIMIT: usize = 32;

/// Agente cujo perfil esta sendo escolhido. O valor de fio e `claude` ou
/// `codex`, o mesmo prefixo do id do perfil.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Agent::Claude),
            "codex" => Some(Agent::Codex),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    fn markers(self) -> &'static [&'static str] {
        match self {
            Agent::Claude => CLAUDE_MARKERS,
            Agent::Codex => CODEX_MARKERS,
        }
    }

    /// As duas variaveis que apontam o agente para uma pasta de configuracao.
    /// A primeira leva o caminho, a segunda o nome do perfil.
    pub fn env_names(self) -> (&'static str, &'static str) {
        match self {
            Agent::Claude => ("CLAUDE_CONFIG_DIR", "CLAUDE_PROFILE"),
            Agent::Codex => ("CODEX_HOME", "CODEX_PROFILE"),
        }
    }
}

/// Nome de perfil aceito: letras minusculas, digitos e hifen, ate
/// [`NAME_LIMIT`] caracteres, sem comecar nem terminar em hifen.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_LIMIT
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
}

/// Sufixo do id: `claude-webrota` vira `webrota`, e `claude` vira `None`, que
/// e o perfil padrao.
pub fn slug_of(agent: Agent, id: &str) -> Option<Option<&str>> {
    let base = agent.as_str();
    if id == base {
        return Some(None);
    }
    let rest = id.strip_prefix(base)?.strip_prefix('-')?;
    valid_name(rest).then_some(Some(rest))
}

/// Pasta de um id de perfil, sem conferir se ela existe.
pub fn dir_of(home: &Path, agent: Agent, id: &str) -> Option<PathBuf> {
    let slug = slug_of(agent, id)?;
    Some(match slug {
        None => home.join(format!(".{}", agent.as_str())),
        Some(name) => home.join(format!(".{}-{name}", agent.as_str())),
    })
}

/// A pasta existe e tem pelo menos um marcador do agente.
pub fn is_profile_dir(dir: &Path, agent: Agent) -> bool {
    dir.is_dir()
        && (agent
            .markers()
            .iter()
            .any(|marker| dir.join(marker).exists())
            || dir.join("sqlite/codex-dev.db").exists())
}

/// Ambiente que um shell novo recebe para o agente usar o perfil escolhido.
///
/// Devolve um par por variavel: `Some(valor)` define, `None` remove. O perfil
/// padrao remove as duas, para o agente cair no proprio padrao dele; um perfil
/// nomeado define o caminho e o nome. Sem escolha, ou com uma pasta que sumiu
/// ou perdeu os marcadores, devolve vazio: nada e tocado e o shell herda o que
/// sempre herdou.
pub fn env_for(home: &Path, agent: Agent, id: &str) -> Vec<(&'static str, Option<String>)> {
    let (dir_var, name_var) = agent.env_names();
    let Some(slug) = slug_of(agent, id) else {
        return Vec::new();
    };
    let Some(dir) = dir_of(home, agent, id) else {
        return Vec::new();
    };
    if !is_profile_dir(&dir, agent) {
        return Vec::new();
    }
    match slug {
        None => vec![(dir_var, None), (name_var, None)],
        Some(name) => vec![
            (dir_var, Some(crate::platform::to_portable(&dir))),
            (name_var, Some(name.to_string())),
        ],
    }
}

/// Cria a pasta de um perfil novo, vazia e so para o dono.
///
/// Nao escreve credencial nenhuma: o login e feito pelo proprio CLI, no
/// terminal que a interface abre em seguida.
pub fn create(home: &Path, agent: Agent, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(crate::i18n::t("native.error.profileNameInvalid"));
    }
    let dir = home.join(format!(".{}-{name}", agent.as_str()));
    if dir.exists() {
        return Err(crate::i18n::t("native.error.profileExists"));
    }
    std::fs::create_dir(&dir).map_err(|error| error.to_string())?;
    restrict(&dir);
    Ok(dir)
}

#[cfg(unix)]
fn restrict(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict(_dir: &Path) {
    // No Windows a pasta nasce com a herança do perfil do usuário, que já é
    // restrita a ele.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cialai-perfis-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_name_accepts_only_lowercase_digits_and_hyphen() {
        for good in ["work", "conta-2", "a", "x".repeat(NAME_LIMIT).as_str()] {
            assert!(valid_name(good), "{good} deveria valer");
        }
        for bad in [
            "",
            "-x",
            "x-",
            "Work",
            "com espaço",
            "../fuga",
            "a/b",
            &"x".repeat(NAME_LIMIT + 1),
        ] {
            assert!(!valid_name(bad), "{bad} nao pode valer");
        }
    }

    #[test]
    fn the_default_profile_clears_the_variables_and_a_named_one_sets_them() {
        let home = scratch("env");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "").unwrap();
        std::fs::create_dir_all(home.join(".codex-work")).unwrap();
        std::fs::write(home.join(".codex-work/auth.json"), "{}").unwrap();

        assert_eq!(
            env_for(&home, Agent::Codex, "codex"),
            vec![("CODEX_HOME", None), ("CODEX_PROFILE", None)],
        );
        assert_eq!(
            env_for(&home, Agent::Codex, "codex-work"),
            vec![
                (
                    "CODEX_HOME",
                    Some(crate::platform::to_portable(home.join(".codex-work")))
                ),
                ("CODEX_PROFILE", Some("work".to_string())),
            ],
        );
        // Pasta que sumiu ou perdeu os marcadores nao muda nada.
        assert!(env_for(&home, Agent::Codex, "codex-sumiu").is_empty());
        std::fs::create_dir_all(home.join(".codex-vazio")).unwrap();
        assert!(env_for(&home, Agent::Codex, "codex-vazio").is_empty());
        // Id de outro agente ou id invalido tambem nao.
        assert!(env_for(&home, Agent::Claude, "codex-work").is_empty());
        assert!(env_for(&home, Agent::Codex, "codex-../fuga").is_empty());

        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn creating_a_profile_makes_an_empty_private_folder_and_refuses_to_overwrite() {
        let home = scratch("criar");
        let dir = create(&home, Agent::Claude, "nova").expect("cria");
        assert_eq!(dir, home.join(".claude-nova"));
        assert!(dir.is_dir());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "nasce vazia");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "so o dono entra");
        }
        assert!(
            create(&home, Agent::Claude, "nova").is_err(),
            "nao sobrescreve"
        );
        assert!(create(&home, Agent::Claude, "Nome Errado").is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_slug_comes_from_the_id_and_the_default_has_none() {
        assert_eq!(slug_of(Agent::Claude, "claude"), Some(None));
        assert_eq!(
            slug_of(Agent::Claude, "claude-webrota"),
            Some(Some("webrota"))
        );
        assert_eq!(slug_of(Agent::Codex, "codex-amorim"), Some(Some("amorim")));
        assert_eq!(slug_of(Agent::Codex, "claude"), None);
        assert_eq!(slug_of(Agent::Codex, "codex-"), None);
        assert_eq!(Agent::parse("claude"), Some(Agent::Claude));
        assert_eq!(Agent::parse("outro"), None);
    }
}
