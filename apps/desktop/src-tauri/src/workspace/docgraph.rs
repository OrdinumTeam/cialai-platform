// SPDX-License-Identifier: Apache-2.0
//! Descoberta de Markdown para o grafo da documentacao do estudio.
//!
//! O grafo mostra os arquivos `.md` do projeto da sessao e so as pastas que
//! levam ate eles. Aqui fica a parte que vai ao disco: uma varredura da raiz
//! inteira, por caminhos e metadados, sem abrir nenhum arquivo. A hierarquia
//! podada e montada no webview, por funcao pura, a partir da lista devolvida.
//! A poda acontece depois de conhecer todos os descendentes: a varredura nunca
//! para numa pasta so porque ela ainda nao tem Markdown.
//!
//! Por que um modulo proprio e nao o `build_index` de [`files`]: os dois so
//! dividem o esqueleto do laco. Este precisa de cancelamento, prazo, teto de
//! profundidade, erro de leitura relatado e outra regra para pastas ocultas, e
//! mexer no outro mudaria a ordem que o ⌘P mostra. O que e comum vem de la:
//! [`files::SKIP_DIRS`], [`files::is_noise`], o mesmo `file_type()` que nao
//! segue links e o mesmo [`FsError`].
//!
//! Vale nos tres sistemas. O que e de um so fica atras de `cfg`: link
//! simbolico e permissao de pasta so existem no Unix, e a sujeira do sistema
//! vem de [`files::is_noise`], que ja escolhe a lista por sistema.
//!
//! Politica, em resumo:
//!
//! - **Exclusoes**: as pastas pesadas e geradas de `SKIP_DIRS`, as ocultas
//!   geradas de [`SKIP_HIDDEN_DIRS`], qualquer pasta que comece por `.venv`,
//!   `worktrees` dentro de pasta oculta e toda pasta marcada com
//!   `CACHEDIR.TAG`. As demais ocultas sao percorridas: `.github`, `.claude` e
//!   afins guardam documentacao de verdade. `.gitignore` nao e lido, porque os
//!   projetos da casa mantem documentacao legitima fora do Git.
//! - **Links simbolicos**: pasta simbolica nunca e percorrida, o que tambem
//!   elimina ciclos. Arquivo simbolico `.md` so entra quando o alvo e um
//!   arquivo regular dentro da raiz. O resto e exclusao por politica, contada
//!   em [`ScanExcluded`], e nao torna a leitura parcial.
//! - **Leitura parcial**: pasta sem permissao, erro de leitura, profundidade,
//!   teto de entradas e prazo viram [`ScanIssue`] ou `stopped`, e o resultado
//!   sai marcado `partial`. Uma varredura parcial nunca se passa por completa.
//! - **Determinismo**: em largura, com as subpastas de cada pasta ordenadas,
//!   para o que cabe dentro de um teto nao variar de uma varredura para outra.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::i18n::t;

use super::files::{self, FsError, FsResult};

/// Entradas visitadas antes de parar e marcar o resultado como parcial.
pub const SCAN_VISIT_LIMIT: usize = 400_000;
/// Prazo da varredura. Passando dele o resultado sai parcial.
pub const SCAN_TIME_BUDGET: Duration = Duration::from_secs(10);
/// Profundidade maxima, a mesma da copia recursiva de `files`.
pub const SCAN_DEPTH_LIMIT: usize = 64;
/// Ocorrencias detalhadas por resultado. O total sempre acompanha.
pub const SCAN_ISSUE_CAP: usize = 200;
/// De quantas em quantas entradas o cancelamento e o prazo sao conferidos.
const POLL_EVERY: usize = 256;
/// Marcador de pasta de cache: https://bford.info/cachedir/
const CACHE_TAG: &str = "CACHEDIR.TAG";

/// Pastas ocultas geradas por ferramentas. Somam-se a `SKIP_DIRS`; as demais
/// ocultas sao percorridas.
const SKIP_HIDDEN_DIRS: &[&str] = &[
    ".dev-browser-panel",
    ".expo",
    ".yarn",
    ".pnpm-store",
    ".pnpm",
    ".dart_tool",
    ".bundle",
    ".serverless",
    ".aws-sam",
    ".vercel",
    ".netlify",
    ".docusaurus",
    ".vite",
    ".nx",
    ".output",
    ".build",
    ".swiftpm",
    ".ipynb_checkpoints",
    ".sass-cache",
    ".history",
    ".trash",
    ".stversions",
    ".Trash",
];

/// Limites de uma varredura. Os testes reduzem para forcar o resultado parcial.
#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub visit_limit: usize,
    pub time_budget: Duration,
    pub depth_limit: usize,
    pub issue_cap: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            visit_limit: SCAN_VISIT_LIMIT,
            time_budget: SCAN_TIME_BUDGET,
            depth_limit: SCAN_DEPTH_LIMIT,
            issue_cap: SCAN_ISSUE_CAP,
        }
    }
}

/// Um Markdown elegivel. `relative` usa `/` e os nomes como estao no disco.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    pub relative: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub symlink: bool,
    /// Para links, o alvo relativo a raiz.
    pub target: Option<String>,
}

/// Um trecho que nao pode ser lido. `relative` e a pasta, vazio para a raiz.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub relative: String,
    /// `denied`, `io` ou `depth`.
    pub code: String,
}

/// O que ficou de fora por politica. Informativo: nao torna a leitura parcial.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanExcluded {
    pub symlink_dirs: u32,
    pub outside_root: u32,
    pub broken_links: u32,
    pub invalid_names: u32,
    pub vanished: u32,
    pub cache_dirs: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocScan {
    pub key: String,
    pub token: String,
    /// A raiz exatamente como foi pedida, para o webview conferir se a
    /// resposta ainda e da raiz atual.
    pub root: String,
    /// A raiz com links resolvidos e a caixa do disco. Chave do estado salvo.
    pub canonical_root: String,
    /// Ordenado por `relative`.
    pub docs: Vec<DocEntry>,
    /// Pastas ancestrais distintas contando a raiz. Zero sem documentos.
    pub dirs: usize,
    pub visited: usize,
    pub elapsed_ms: u64,
    pub partial: bool,
    /// `limit` ou `timeout` quando a varredura parou antes do fim.
    pub stopped: Option<String>,
    pub issues: Vec<ScanIssue>,
    pub issues_total: usize,
    pub excluded: ScanExcluded,
    /// Muda so quando o conjunto de documentos ou de ocorrencias muda.
    pub fingerprint: String,
}

fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

/// Pastas que a varredura nao abre. `parent_hidden` diz se a pasta que a
/// contem e oculta, para pular as copias de repositorio em `.x/worktrees`.
pub(crate) fn skip_doc_dir(name: &str, parent_hidden: bool) -> bool {
    files::SKIP_DIRS.contains(&name)
        || SKIP_HIDDEN_DIRS.contains(&name)
        || name.starts_with(".venv")
        || (parent_hidden && name == "worktrees")
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn issue_code(error: &std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        "denied"
    } else {
        "io"
    }
}

struct Report {
    issues: Vec<ScanIssue>,
    issues_total: usize,
    cap: usize,
}

impl Report {
    fn push(&mut self, relative: &str, code: &str) {
        self.issues_total += 1;
        if self.issues.len() < self.cap {
            self.issues.push(ScanIssue {
                relative: relative.to_string(),
                code: code.to_string(),
            });
        }
    }
}

enum Link {
    Inside {
        target: String,
        size: u64,
        modified_ms: Option<u64>,
    },
    Outside,
    Broken,
    Directory,
}

/// Resolve um link simbolico contra a raiz canonizada.
fn resolve_link(path: &Path, canonical_root: &Path) -> Link {
    let Ok(target) = fs::canonicalize(path) else {
        return Link::Broken;
    };
    let Ok(meta) = fs::metadata(&target) else {
        return Link::Broken;
    };
    if meta.is_dir() {
        return Link::Directory;
    }
    if !meta.is_file() {
        return Link::Broken;
    }
    match target.strip_prefix(canonical_root) {
        Ok(inside) => Link::Inside {
            target: inside.to_string_lossy().to_string(),
            size: meta.len(),
            modified_ms: files::modified_ms(&meta),
        },
        Err(_) => Link::Outside,
    }
}

fn count_dirs(docs: &[DocEntry]) -> usize {
    if docs.is_empty() {
        return 0;
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for doc in docs {
        for (index, character) in doc.relative.char_indices() {
            if character == '/' {
                seen.insert(&doc.relative[..index]);
            }
        }
    }
    seen.len() + 1
}

fn fingerprint_of(
    docs: &[DocEntry],
    issues: &[ScanIssue],
    issues_total: usize,
    stopped: Option<&str>,
) -> String {
    let mut hasher = DefaultHasher::new();
    for doc in docs {
        doc.relative.hash(&mut hasher);
        doc.symlink.hash(&mut hasher);
    }
    for issue in issues {
        issue.relative.hash(&mut hasher);
        issue.code.hash(&mut hasher);
    }
    issues_total.hash(&mut hasher);
    stopped.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn cancelled() -> FsError {
    FsError::new("cancelled", t("native.error.scanCancelled"))
}

/// Varre `root` atras de arquivos `.md`. `cancel` e conferido a cada pasta e a
/// cada [`POLL_EVERY`] entradas. `key` e `token` do resultado saem vazios;
/// quem chama preenche.
pub fn scan(root: &str, cancel: &AtomicBool, options: &ScanOptions) -> FsResult<DocScan> {
    let started = Instant::now();
    let requested = files::absolute(root)?;
    let root_meta = fs::metadata(&requested)
        .map_err(|error| FsError::io(error, &t("native.error.openFolder")))?;
    if !root_meta.is_dir() {
        return Err(FsError::new("not_found", t("native.error.folderNotFound")));
    }
    let canonical_root = fs::canonicalize(&requested)
        .map_err(|error| FsError::io(error, &t("native.error.resolveFolder")))?;

    let mut docs: Vec<DocEntry> = Vec::new();
    let mut report = Report {
        issues: Vec::new(),
        issues_total: 0,
        cap: options.issue_cap,
    };
    let mut excluded = ScanExcluded::default();
    let mut visited = 0usize;
    let mut stopped: Option<&'static str> = None;
    // Pasta, caminho relativo, profundidade e se a propria pasta e oculta.
    let mut queue: VecDeque<(PathBuf, String, usize, bool)> = VecDeque::new();
    queue.push_back((requested.clone(), String::new(), 0, false));

    while let Some((dir, relative, depth, hidden)) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if started.elapsed() >= options.time_budget {
            stopped = Some("timeout");
            break;
        }
        let read = match fs::read_dir(&dir) {
            Ok(read) => read,
            Err(error) if depth == 0 => {
                return Err(FsError::io(error, &t("native.error.listFolder")));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Sumiu entre a listagem do pai e agora: nada a relatar.
                excluded.vanished += 1;
                continue;
            }
            Err(error) => {
                report.push(&relative, issue_code(&error));
                continue;
            }
        };

        // O que a pasta rende so e confirmado depois do laco: se aparecer o
        // marcador de cache, tudo dela e descartado.
        let mut found: Vec<DocEntry> = Vec::new();
        let mut subdirs: Vec<String> = Vec::new();
        let mut tagged = false;
        for item in read {
            let item = match item {
                Ok(item) => item,
                Err(error) => {
                    report.push(&relative, issue_code(&error));
                    continue;
                }
            };
            visited += 1;
            if visited > options.visit_limit {
                stopped = Some("limit");
                break;
            }
            if visited % POLL_EVERY == 0 {
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                if started.elapsed() >= options.time_budget {
                    stopped = Some("timeout");
                    break;
                }
            }
            let Some(name) = item.file_name().to_str().map(str::to_string) else {
                // Nome fora do UTF-8: a versao com perdas poderia colidir.
                excluded.invalid_names += 1;
                continue;
            };
            if files::is_noise(&name) {
                continue;
            }
            if depth > 0 && name == CACHE_TAG {
                tagged = true;
                break;
            }
            let Ok(file_type) = item.file_type() else {
                excluded.vanished += 1;
                continue;
            };
            if file_type.is_dir() {
                if !skip_doc_dir(&name, hidden) {
                    subdirs.push(name);
                }
                continue;
            }
            if file_type.is_symlink() {
                let markdown = is_markdown(&name);
                match resolve_link(&item.path(), &canonical_root) {
                    Link::Directory => excluded.symlink_dirs += 1,
                    Link::Inside {
                        target,
                        size,
                        modified_ms,
                    } if markdown => found.push(DocEntry {
                        relative: join_relative(&relative, &name),
                        size,
                        modified_ms,
                        symlink: true,
                        target: Some(target),
                    }),
                    Link::Outside if markdown => excluded.outside_root += 1,
                    Link::Broken if markdown => excluded.broken_links += 1,
                    _ => {}
                }
                continue;
            }
            if !file_type.is_file() || !is_markdown(&name) {
                continue;
            }
            // `metadata` de uma entrada nao segue links e nao abre o arquivo:
            // um Markdown sem permissao de leitura continua no indice.
            match item.metadata() {
                Ok(meta) => found.push(DocEntry {
                    relative: join_relative(&relative, &name),
                    size: meta.len(),
                    modified_ms: files::modified_ms(&meta),
                    symlink: false,
                    target: None,
                }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    excluded.vanished += 1
                }
                Err(_) => found.push(DocEntry {
                    relative: join_relative(&relative, &name),
                    size: 0,
                    modified_ms: None,
                    symlink: false,
                    target: None,
                }),
            }
        }

        if tagged {
            excluded.cache_dirs += 1;
            continue;
        }
        docs.append(&mut found);
        if stopped.is_some() {
            break;
        }
        subdirs.sort();
        for name in subdirs {
            let child = join_relative(&relative, &name);
            if depth + 1 > options.depth_limit {
                report.push(&child, "depth");
                continue;
            }
            let child_hidden = name.starts_with('.');
            queue.push_back((dir.join(&name), child, depth + 1, child_hidden));
        }
    }

    docs.sort_by(|a, b| a.relative.cmp(&b.relative));
    let fingerprint = fingerprint_of(&docs, &report.issues, report.issues_total, stopped);
    Ok(DocScan {
        key: String::new(),
        token: String::new(),
        root: requested.to_string_lossy().to_string(),
        canonical_root: canonical_root.to_string_lossy().to_string(),
        dirs: count_dirs(&docs),
        docs,
        visited,
        elapsed_ms: started.elapsed().as_millis() as u64,
        partial: report.issues_total > 0 || stopped.is_some(),
        stopped: stopped.map(str::to_string),
        issues: report.issues,
        issues_total: report.issues_total,
        excluded,
        fingerprint,
    })
}

/* ── registro de varreduras em andamento ───────────────────────────── */

type Active = HashMap<String, (String, Arc<AtomicBool>)>;

/// Varreduras em andamento, uma por chave. A chave e a sessao do estudio; o
/// token identifica cada pedido. Com o token, o fim de uma varredura antiga nao
/// apaga o registro da nova, e um cancelamento que chega atrasado nao derruba
/// a varredura seguinte.
#[derive(Clone, Default)]
pub struct DocScans {
    active: Arc<Mutex<Active>>,
}

/// Mantem o registro enquanto a varredura roda e o desfaz ao sair de escopo,
/// inclusive num panic: o perfil de release nao aborta.
pub struct ScanGuard {
    scans: DocScans,
    key: String,
    token: String,
    flag: Arc<AtomicBool>,
}

impl ScanGuard {
    pub fn flag(&self) -> &AtomicBool {
        &self.flag
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        self.scans.finish(&self.key, &self.token);
    }
}

impl DocScans {
    fn lock(&self) -> std::sync::MutexGuard<'_, Active> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registra um pedido. Se a chave ja tinha uma varredura, ela e cancelada.
    pub fn begin(&self, key: &str, token: &str) -> ScanGuard {
        let flag = Arc::new(AtomicBool::new(false));
        let previous = self
            .lock()
            .insert(key.to_string(), (token.to_string(), flag.clone()));
        if let Some((_, old)) = previous {
            old.store(true, Ordering::Relaxed);
        }
        ScanGuard {
            scans: self.clone(),
            key: key.to_string(),
            token: token.to_string(),
            flag,
        }
    }

    /// Remove o registro so se ele ainda for deste token.
    fn finish(&self, key: &str, token: &str) {
        let mut active = self.lock();
        if active
            .get(key)
            .map(|(current, _)| current == token)
            .unwrap_or(false)
        {
            active.remove(key);
        }
    }

    /// Cancela a varredura da chave. Com `token`, so se for a desse pedido.
    pub fn cancel(&self, key: &str, token: Option<&str>) -> bool {
        let active = self.lock();
        match active.get(key) {
            Some((current, flag)) if token.map(|wanted| wanted == current).unwrap_or(true) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn sandbox(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cialai-docgraph-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    fn run(root: &Path) -> DocScan {
        scan(
            &root.to_string_lossy(),
            &AtomicBool::new(false),
            &ScanOptions::default(),
        )
        .unwrap()
    }

    fn paths(result: &DocScan) -> Vec<&str> {
        result
            .docs
            .iter()
            .map(|doc| doc.relative.as_str())
            .collect()
    }

    #[test]
    fn mandatory_example() {
        let dir = sandbox("exemplo");
        touch(&dir, "programas/azul/README.md");
        touch(&dir, "programas/azul/arquitetura.md");
        touch(&dir, "programas/azul/tarefas.md");
        touch(&dir, "programas/verde/docs/instalacao.md");
        touch(&dir, "programas/vermelho/src/app.ts");
        touch(&dir, "backend/controllers/user.ts");
        touch(&dir, "infra/docker/compose.yml");
        let result = run(&dir);
        assert_eq!(
            paths(&result),
            vec![
                "programas/azul/README.md",
                "programas/azul/arquitetura.md",
                "programas/azul/tarefas.md",
                "programas/verde/docs/instalacao.md",
            ]
        );
        // Raiz, programas, azul, verde e docs.
        assert_eq!(result.dirs, 5);
        assert!(!result.partial);
        assert!(result.stopped.is_none());
        assert!(paths(&result).iter().all(|path| !path.contains("vermelho")
            && !path.contains("backend")
            && !path.contains("infra")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deep_doc_under_bare_folders() {
        let dir = sandbox("fundo");
        touch(&dir, "a/b/c/d/e/nota.md");
        touch(&dir, "a/b/outro.txt");
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["a/b/c/d/e/nota.md"]);
        assert_eq!(result.dirs, 6);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn root_markdown_and_repeated_names_keep_case() {
        let dir = sandbox("nomes");
        touch(&dir, "README.md");
        touch(&dir, "docs/README.md");
        touch(&dir, "Guia/Relatório Ação.MD");
        let result = run(&dir);
        assert_eq!(
            paths(&result),
            vec!["Guia/Relatório Ação.MD", "README.md", "docs/README.md"]
        );
        assert_eq!(result.dirs, 3);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extension_rules() {
        let dir = sandbox("extensao");
        touch(&dir, "a.md");
        touch(&dir, "b.Md");
        touch(&dir, "c.markdown");
        touch(&dir, "d.mdx");
        touch(&dir, "e.md.bak");
        touch(&dir, ".md");
        touch(&dir, "notas.md/dentro.md");
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["a.md", "b.Md", "notas.md/dentro.md"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_project_is_not_partial() {
        let dir = sandbox("vazio");
        touch(&dir, "src/main.rs");
        let result = run(&dir);
        assert!(result.docs.is_empty());
        assert_eq!(result.dirs, 0);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn skips_heavy_and_generated() {
        let dir = sandbox("pesadas");
        touch(&dir, "docs/ok.md");
        touch(&dir, "node_modules/pacote/README.md");
        touch(&dir, ".git/descricao.md");
        touch(&dir, "target/doc/index.md");
        touch(&dir, ".venv-ci/lib/LICENSE.md");
        touch(&dir, ".dev-browser-panel/nota.md");
        touch(&dir, ".claude/worktrees/copia/README.md");
        touch(&dir, "._recurso.md");
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["docs/ok.md"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_hidden_and_gitignored_docs() {
        let dir = sandbox("ocultas");
        touch(&dir, ".github/PULL_REQUEST_TEMPLATE.md");
        touch(&dir, ".superpowers/plano.md");
        touch(&dir, ".claude/CLAUDE.md");
        touch(&dir, "plan/plan.md");
        touch(&dir, "_INTERNO_ORDINUM/acesso.md");
        touch(&dir, "worktrees/nota.md");
        fs::write(dir.join(".gitignore"), "_INTERNO_ORDINUM/\nplan/\n").unwrap();
        let result = run(&dir);
        assert_eq!(
            paths(&result),
            vec![
                ".claude/CLAUDE.md",
                ".github/PULL_REQUEST_TEMPLATE.md",
                ".superpowers/plano.md",
                "_INTERNO_ORDINUM/acesso.md",
                "plan/plan.md",
                "worktrees/nota.md",
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cachedir_tag_discards_folder_but_not_root() {
        let dir = sandbox("cache");
        touch(&dir, CACHE_TAG);
        touch(&dir, "LEIAME.md");
        touch(&dir, "guardado/CACHEDIR.TAG");
        touch(&dir, "guardado/a.md");
        touch(&dir, "guardado/sub/b.md");
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["LEIAME.md"]);
        assert_eq!(result.excluded.cache_dirs, 1);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn dir_symlink_not_followed_and_cycle_safe() {
        let dir = sandbox("ciclo");
        touch(&dir, "real/a.md");
        symlink(&dir, dir.join("laco")).unwrap();
        symlink(dir.join("real"), dir.join("atalho")).unwrap();
        symlink(dir.join("real"), dir.join("atalho.md")).unwrap();
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["real/a.md"]);
        assert_eq!(result.excluded.symlink_dirs, 3);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_symlink_inside_root() {
        let dir = sandbox("link-dentro");
        touch(&dir, "AGENTS.md");
        symlink("AGENTS.md", dir.join("CLAUDE.md")).unwrap();
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["AGENTS.md", "CLAUDE.md"]);
        let link = &result.docs[1];
        assert!(link.symlink);
        assert_eq!(link.target.as_deref(), Some("AGENTS.md"));
        assert!(!result.docs[0].symlink);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_symlink_outside_root_and_broken_are_not_partial() {
        let dir = sandbox("link-fora");
        let outside = sandbox("link-fora-alvo");
        touch(&outside, "externo.md");
        touch(&dir, "dentro.md");
        symlink(outside.join("externo.md"), dir.join("externo.md")).unwrap();
        symlink(dir.join("nao-existe.md"), dir.join("morto.md")).unwrap();
        let result = run(&dir);
        assert_eq!(paths(&result), vec!["dentro.md"]);
        assert_eq!(result.excluded.outside_root, 1);
        assert_eq!(result.excluded.broken_links, 1);
        assert!(
            !result.partial,
            "exclusao por politica nao e leitura parcial"
        );
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_root_echoes_request_and_reports_canonical() {
        let real = sandbox("raiz-real");
        let holder = sandbox("raiz-link");
        touch(&real, "docs/a.md");
        symlink("b.md", real.join("docs/atalho.md")).unwrap();
        touch(&real, "docs/b.md");
        let alias = holder.join("projeto");
        symlink(&real, &alias).unwrap();
        let result = run(&alias);
        assert_eq!(result.root, alias.to_string_lossy());
        assert_eq!(
            result.canonical_root,
            fs::canonicalize(&real).unwrap().to_string_lossy()
        );
        // O link interno continua dentro: a comparacao e entre canonicos.
        assert_eq!(
            paths(&result),
            vec!["docs/a.md", "docs/atalho.md", "docs/b.md"]
        );
        fs::remove_dir_all(&real).unwrap();
        fs::remove_dir_all(&holder).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_markdown_still_indexed() {
        let dir = sandbox("sem-leitura");
        touch(&dir, "trancado.md");
        let file = dir.join("trancado.md");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        let result = run(&dir);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        // So caminhos e metadados: o conteudo nunca e aberto.
        assert_eq!(paths(&result), vec!["trancado.md"]);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn denied_dir_is_partial_with_relative() {
        let dir = sandbox("negada");
        touch(&dir, "aberta/a.md");
        touch(&dir, "fechada/segredo.md");
        let locked = dir.join("fechada");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let result = run(&dir);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(paths(&result), vec!["aberta/a.md"]);
        assert!(result.partial);
        assert_eq!(result.issues_total, 1);
        assert_eq!(
            result.issues[0],
            ScanIssue {
                relative: "fechada".into(),
                code: "denied".into()
            }
        );
        assert!(result.stopped.is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn visit_limit_stops_and_flags() {
        let dir = sandbox("teto");
        for index in 0..20 {
            touch(&dir, &format!("pasta/nota-{index:02}.md"));
        }
        let options = ScanOptions {
            visit_limit: 5,
            ..ScanOptions::default()
        };
        let result = scan(&dir.to_string_lossy(), &AtomicBool::new(false), &options).unwrap();
        assert_eq!(result.stopped.as_deref(), Some("limit"));
        assert!(result.partial);
        assert!(result.docs.len() < 20);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn zero_budget_times_out() {
        let dir = sandbox("prazo");
        touch(&dir, "a.md");
        let options = ScanOptions {
            time_budget: Duration::ZERO,
            ..ScanOptions::default()
        };
        let result = scan(&dir.to_string_lossy(), &AtomicBool::new(false), &options).unwrap();
        assert_eq!(result.stopped.as_deref(), Some("timeout"));
        assert!(result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn depth_cap_reports_issue() {
        let dir = sandbox("profundidade");
        touch(&dir, "a/raso.md");
        touch(&dir, "a/b/c/fundo.md");
        let options = ScanOptions {
            depth_limit: 2,
            ..ScanOptions::default()
        };
        let result = scan(&dir.to_string_lossy(), &AtomicBool::new(false), &options).unwrap();
        assert_eq!(paths(&result), vec!["a/raso.md"]);
        assert!(result.partial);
        assert_eq!(
            result.issues[0],
            ScanIssue {
                relative: "a/b/c".into(),
                code: "depth".into()
            }
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn issue_cap_keeps_total() {
        let dir = sandbox("muitas");
        let mut locked = Vec::new();
        for index in 0..5 {
            touch(&dir, &format!("p{index}/a.md"));
            let path = dir.join(format!("p{index}"));
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
            locked.push(path);
        }
        let options = ScanOptions {
            issue_cap: 2,
            ..ScanOptions::default()
        };
        let result = scan(&dir.to_string_lossy(), &AtomicBool::new(false), &options).unwrap();
        for path in locked {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(result.issues.len(), 2);
        assert_eq!(result.issues_total, 5);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn preset_flag_cancels() {
        let dir = sandbox("cancelada");
        touch(&dir, "a.md");
        let error = scan(
            &dir.to_string_lossy(),
            &AtomicBool::new(true),
            &ScanOptions::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_roots() {
        assert_eq!(
            scan(
                "relativo/sem/raiz",
                &AtomicBool::new(false),
                &ScanOptions::default()
            )
            .unwrap_err()
            .code,
            "invalid"
        );
        let missing =
            std::env::temp_dir().join(format!("cialai-docgraph-nao-existe-{}", std::process::id()));
        assert_eq!(
            scan(
                &missing.to_string_lossy(),
                &AtomicBool::new(false),
                &ScanOptions::default()
            )
            .unwrap_err()
            .code,
            "not_found"
        );
        let dir = sandbox("arquivo-raiz");
        touch(&dir, "a.md");
        let file = dir.join("a.md");
        assert_eq!(
            scan(
                &file.to_string_lossy(),
                &AtomicBool::new(false),
                &ScanOptions::default()
            )
            .unwrap_err()
            .code,
            "not_found"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn fingerprint_follows_structure_not_content() {
        let dir = sandbox("digital");
        touch(&dir, "docs/a.md");
        let first = run(&dir);
        fs::write(dir.join("docs/a.md"), "conteudo novo e maior").unwrap();
        let edited = run(&dir);
        assert_eq!(first.fingerprint, edited.fingerprint);
        touch(&dir, "docs/b.md");
        let grown = run(&dir);
        assert_ne!(first.fingerprint, grown.fingerprint);
        fs::rename(dir.join("docs/b.md"), dir.join("docs/c.md")).unwrap();
        assert_ne!(grown.fingerprint, run(&dir).fingerprint);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sparse_thousand_folders_keep_only_documented_paths() {
        let dir = sandbox("esparso");
        for top in 0..100 {
            for sub in 0..10 {
                touch(&dir, &format!("area-{top:03}/modulo-{sub}/codigo.rs"));
            }
        }
        for top in [3, 17, 21, 34, 48, 55, 62, 79, 86, 99] {
            touch(&dir, &format!("area-{top:03}/modulo-4/docs/guia.md"));
        }
        let result = run(&dir);
        assert_eq!(result.docs.len(), 10);
        // Raiz mais tres niveis por area documentada.
        assert_eq!(result.dirs, 1 + 10 * 3);
        assert!(result.visited > 1_000);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn registry_replaces_and_survives_old_finish() {
        let scans = DocScans::default();
        let first = scans.begin("sessao", "t1");
        let second = scans.begin("sessao", "t2");
        assert!(
            first.flag().load(Ordering::Relaxed),
            "o pedido novo cancela o anterior"
        );
        assert!(!second.flag().load(Ordering::Relaxed));
        // O fim do pedido antigo nao apaga o registro do novo.
        drop(first);
        assert_eq!(scans.len(), 1);
        assert!(scans.cancel("sessao", None));
        assert!(second.flag().load(Ordering::Relaxed));
        drop(second);
        assert_eq!(scans.len(), 0);
    }

    #[test]
    fn cancel_is_token_qualified() {
        let scans = DocScans::default();
        let current = scans.begin("sessao", "t2");
        // Um cancelamento atrasado, do pedido anterior, nao derruba este.
        assert!(!scans.cancel("sessao", Some("t1")));
        assert!(!current.flag().load(Ordering::Relaxed));
        assert!(!scans.cancel("outra", None));
        assert!(scans.cancel("sessao", Some("t2")));
        assert!(current.flag().load(Ordering::Relaxed));
    }

    /// Medida num projeto de verdade: `CIALAI_DOCGRAPH_BENCH_ROOT=/caminho cargo
    /// test docgraph_bench -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn docgraph_bench() {
        let Ok(root) = std::env::var("CIALAI_DOCGRAPH_BENCH_ROOT") else {
            return;
        };
        for round in 0..3 {
            let result = scan(&root, &AtomicBool::new(false), &ScanOptions::default()).unwrap();
            println!(
                "rodada {round}: {} docs, {} pastas, {} entradas, {} ms, parcial {}, parou {:?}, excluido {:?}",
                result.docs.len(),
                result.dirs,
                result.visited,
                result.elapsed_ms,
                result.partial,
                result.stopped,
                result.excluded
            );
        }
    }
}
