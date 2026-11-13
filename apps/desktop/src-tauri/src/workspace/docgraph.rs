// SPDX-License-Identifier: Apache-2.0
//! Descoberta de arquivos e das ligacoes entre eles para o grafo do estudio.
//!
//! O grafo tem dois escopos. No escopo `docs`, o padrao, ele mostra os
//! arquivos Markdown do projeto da sessao e so as pastas que levam ate eles.
//! No escopo `project`, mostra todo arquivo que passa pelas mesmas exclusoes,
//! ate [`SCAN_FILE_LIMIT`]. Aqui fica a parte que vai ao disco: uma varredura
//! da raiz inteira por caminhos e metadados e, depois dela, a leitura do
//! comeco dos arquivos de texto conhecidos atras das referencias entre eles.
//! A hierarquia podada e montada no webview, por funcao pura, a partir da
//! lista devolvida. A poda acontece depois de conhecer todos os descendentes:
//! a varredura nunca para numa pasta so porque ela ainda nao tem o que mostrar.
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
//!   elimina ciclos. Arquivo simbolico so entra quando o alvo e um arquivo
//!   regular dentro da raiz; no escopo `docs`, so se o nome for de Markdown.
//!   O resto e exclusao por politica, contada em [`ScanExcluded`], e nao torna
//!   a leitura parcial.
//! - **Leitura parcial**: pasta sem permissao, erro de leitura, profundidade,
//!   teto de entradas, teto de arquivos e prazo viram [`ScanIssue`] ou
//!   `stopped`, e o resultado sai marcado `partial`. Uma varredura parcial
//!   nunca se passa por completa.
//! - **Determinismo**: em largura, com as subpastas de cada pasta ordenadas e,
//!   quando o teto de arquivos corta uma pasta, os nomes dela tambem, para o
//!   que cabe dentro de um teto nao variar de uma varredura para outra.
//! - **Ligacoes**: links, imagens e wikilinks do Markdown, imports relativos
//!   de JS e TS, `@import` e `url()` de estilos, `src` e `href` de HTML,
//!   imports de Python, `mod` e `use` de Rust e imports de Go viram pares
//!   `[origem, alvo]`, so quando o alvo esta na lista. Arquivo simbolico nao
//!   e lido: ele liga ao proprio alvo. Cada arquivo e lido ate
//!   [`LINK_READ_LIMIT`] bytes, a partir da raiz canonica e so se ainda for
//!   arquivo regular, dentro de [`LINK_TIME_BUDGET`]. O que ele referencia
//!   fica num [`LinkCache`] validado por tamanho e data, com teto de memoria.
//!   Leitura ou resolucao interrompida sai em `links_partial` e nunca torna a
//!   varredura parcial: a lista de arquivos continua completa.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
/// Arquivos do escopo `project` antes de parar e marcar o resultado como
/// parcial. O escopo `docs` nao tem esse teto.
pub const SCAN_FILE_LIMIT: usize = 20_000;
/// Prazo da leitura e da resolucao das ligacoes. Nunca passa do que sobra do
/// prazo da varredura, salvo a folga de [`RESOLVE_GRACE`].
pub const LINK_TIME_BUDGET: Duration = Duration::from_secs(3);
/// Bytes lidos do comeco de cada arquivo atras de ligacoes.
pub const LINK_READ_LIMIT: usize = 512 * 1024;
/// Ligacoes por resultado.
pub const LINK_LIMIT: usize = 100_000;
/// Arquivos de onde saem ligacoes, contando os que vem do cache.
pub const LINK_FILE_LIMIT: usize = 20_000;
/// Folga minima da resolucao depois da leitura: o que ja foi lido tem ao
/// menos esse tempo para virar ligacao, mesmo quando a leitura gastou o prazo
/// inteiro. Nunca passa de `link_time_budget`.
const RESOLVE_GRACE: Duration = Duration::from_secs(1);
/// Memoria do [`LinkCache`], somando o [`Ref::weight`] de todas as raizes.
/// Passando disso, as raizes usadas ha mais tempo saem inteiras; o que nao
/// cabe nem sozinho fica fora.
const LINK_CACHE_BUDGET: usize = 64 * 1024 * 1024;
/// Memoria das referencias de uma varredura, vindas do cache ou lidas.
/// Passando disso a leitura para e as ligacoes saem parciais.
const LINK_SCAN_BUDGET: usize = 256 * 1024 * 1024;
/// Referencias guardadas por arquivo, para um arquivo patologico nao
/// encher o cache.
const REFS_PER_FILE: usize = 4_096;
/// Peso guardado por arquivo, somando o [`Ref::weight`] das referencias.
const REF_BYTES_PER_FILE: usize = 64 * 1024;
/// Custo fixo de cada referencia e de cada texto dentro dela, alem dos bytes
/// do texto: o lugar no vetor e a sobra da alocacao.
const REF_OVERHEAD: usize = 32;
/// Caminho mais longo que ainda vira referencia.
const PATH_LIMIT: usize = 1_024;
/// Nomes guardados de um `from x import ...` de Python. O resto vira `*`,
/// que ainda liga ao modulo.
const PYTHON_NAMES_LIMIT: usize = 64;
/// Tokens de uma instrucao `use` de Rust. Acima disso ela e ignorada inteira.
const USE_TOKEN_LIMIT: usize = 4_096;
/// Segmentos de um caminho de `use`. Caminho mais longo derruba a instrucao.
const USE_SEGMENT_LIMIT: usize = 64;
/// Bytes copiados ao abrir os grupos de uma instrucao `use`, contando
/// [`REF_OVERHEAD`] por segmento: segmento enorme nao se multiplica.
const USE_COPY_LIMIT: usize = 256 * 1024;
/// Modulos em linha aninhados que ainda viram prefixo de referencia.
const INLINE_DEPTH_LIMIT: usize = 64;
/// Resolucoes guardadas por varredura, por pasta de origem e referencia.
const RESOLVE_MEMO_LIMIT: usize = 256 * 1024;
/// Idade minima, em ms, das referencias que entram no cache. Arquivo mais
/// novo pode mudar de novo no mesmo tique do relogio do disco, com o mesmo
/// tamanho, e passar pela validacao: a regra de arquivo "racy" do Git.
const RACY_MS: u64 = 3_000;
/// Bytes examinados depois de cada `](`, `url(`, `src=` ou aspa atras do
/// fim do destino.
const SPEC_LIMIT: usize = 512;
/// De quantas em quantas entradas o cancelamento e o prazo sao conferidos.
const POLL_EVERY: usize = 256;
/// De quantas em quantas referencias o cancelamento e o prazo sao
/// conferidos, alem de a cada arquivo.
const RESOLVE_POLL_EVERY: usize = 1_024;
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

/// O que a varredura lista.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ScanScope {
    /// So Markdown, com as pastas que levam ate ele.
    #[default]
    Docs,
    /// Todo arquivo que passa pelas exclusoes, ate o teto de arquivos.
    Project,
}

impl ScanScope {
    /// Le o escopo pedido pelo webview. Ausente ou desconhecido vale `docs`.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("project") => Self::Project,
            _ => Self::Docs,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Docs => "docs",
            Self::Project => "project",
        }
    }
}

/// Limites de uma varredura. Os testes reduzem para forcar o resultado parcial.
#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub visit_limit: usize,
    pub time_budget: Duration,
    pub depth_limit: usize,
    pub issue_cap: usize,
    pub scope: ScanScope,
    /// Teto de arquivos do escopo `project`.
    pub file_limit: usize,
    /// Prazo da leitura e da resolucao das ligacoes, cortado pelo que sobra
    /// de `time_budget`. A resolucao ainda tem a folga de [`RESOLVE_GRACE`].
    pub link_time_budget: Duration,
    /// Bytes lidos do comeco de cada arquivo.
    pub link_read_limit: usize,
    /// Ligacoes por resultado.
    pub link_limit: usize,
    /// Arquivos de onde saem ligacoes, lidos ou vindos do cache.
    pub link_file_limit: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            visit_limit: SCAN_VISIT_LIMIT,
            time_budget: SCAN_TIME_BUDGET,
            depth_limit: SCAN_DEPTH_LIMIT,
            issue_cap: SCAN_ISSUE_CAP,
            scope: ScanScope::Docs,
            file_limit: SCAN_FILE_LIMIT,
            link_time_budget: LINK_TIME_BUDGET,
            link_read_limit: LINK_READ_LIMIT,
            link_limit: LINK_LIMIT,
            link_file_limit: LINK_FILE_LIMIT,
        }
    }
}

impl ScanOptions {
    /// Os limites padrao com o escopo pedido pelo webview, `docs` ou
    /// `project`. Ausente ou desconhecido vale `docs`.
    pub fn for_scope(scope: Option<&str>) -> Self {
        Self {
            scope: ScanScope::parse(scope),
            ..Self::default()
        }
    }
}

/// Um arquivo elegivel: Markdown no escopo `docs`, qualquer um no escopo
/// `project`. `relative` usa `/` e os nomes como estao no disco.
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
    /// `docs` ou `project`: o escopo que a varredura usou de fato.
    pub scope: String,
    /// Ordenado por `relative`.
    pub docs: Vec<DocEntry>,
    /// Referencias entre arquivos, em pares `[origem, alvo]` de indices de
    /// `docs`: sem repeticao, sem laco e em ordem crescente.
    pub links: Vec<[u32; 2]>,
    /// A leitura ou a resolucao das ligacoes parou antes do fim, por prazo ou
    /// pelo teto de ligacoes, de arquivos ou de memoria. Nao torna a varredura
    /// parcial.
    pub links_partial: bool,
    /// Arquivos lidos do disco atras de ligacoes. O que veio do cache nao
    /// conta.
    pub links_read: u32,
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
    /// Muda so quando o escopo ou o conjunto de arquivos, de ligacoes ou de
    /// ocorrencias muda.
    pub fingerprint: String,
}

/// As mesmas extensoes que o editor abre como Markdown, em `kinds.js`.
fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .map(|extension| {
            ["md", "markdown", "mdx"]
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
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
    } else if name.is_empty() {
        parent.to_string()
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

/// Tamanho, datas e `links_read` ficam de fora: editar um arquivo sem mexer
/// nas ligacoes dele nao muda o grafo.
fn fingerprint_of(scan: &DocScan) -> String {
    let mut hasher = DefaultHasher::new();
    scan.scope.hash(&mut hasher);
    for doc in &scan.docs {
        doc.relative.hash(&mut hasher);
        doc.symlink.hash(&mut hasher);
    }
    for issue in &scan.issues {
        issue.relative.hash(&mut hasher);
        issue.code.hash(&mut hasher);
    }
    scan.issues_total.hash(&mut hasher);
    scan.stopped.hash(&mut hasher);
    scan.links.hash(&mut hasher);
    scan.links_partial.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn cancelled() -> FsError {
    FsError::new("cancelled", t("native.error.scanCancelled"))
}

/// Varre `root` atras dos arquivos do escopo e das ligacoes entre eles, sem
/// cache: todo arquivo de onde saem ligacoes e lido. `cancel` e conferido a
/// cada pasta, a cada [`POLL_EVERY`] entradas e a cada arquivo lido. `key` e
/// `token` do resultado saem vazios; quem chama preenche.
pub fn scan(root: &str, cancel: &AtomicBool, options: &ScanOptions) -> FsResult<DocScan> {
    run_scan(root, cancel, options, None)
}

/// Igual a [`scan`], reaproveitando as referencias de `cache` dos arquivos
/// que nao mudaram desde a ultima leitura.
pub fn scan_cached(
    root: &str,
    cancel: &AtomicBool,
    options: &ScanOptions,
    cache: &LinkCache,
) -> FsResult<DocScan> {
    run_scan(root, cancel, options, Some(cache))
}

fn run_scan(
    root: &str,
    cancel: &AtomicBool,
    options: &ScanOptions,
    cache: Option<&LinkCache>,
) -> FsResult<DocScan> {
    let started = Instant::now();
    let project = options.scope == ScanScope::Project;
    let file_cap = if project {
        options.file_limit
    } else {
        usize::MAX
    };
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
    // Arquivos que so existem na nuvem: entram na lista, mas nao sao lidos.
    let mut remote: HashSet<String> = HashSet::new();
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
            // `files::is_noise` escolhe a lista pelo sistema que roda. O
            // `._nome` do AppleDouble entra aqui a mais, em qualquer sistema:
            // ele viaja junto quando a pasta e copiada de um Mac, e um
            // `._guia.md` num Windows continua sendo metadado, nunca documento.
            if files::is_noise(&name) || name.starts_with("._") {
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
            // No escopo `docs` so Markdown entra; no `project`, qualquer nome.
            let eligible = project || is_markdown(&name);
            if file_type.is_symlink() {
                match resolve_link(&item.path(), &canonical_root) {
                    Link::Directory => excluded.symlink_dirs += 1,
                    Link::Inside {
                        target,
                        size,
                        modified_ms,
                    } if eligible => found.push(DocEntry {
                        relative: join_relative(&relative, &name),
                        size,
                        modified_ms,
                        symlink: true,
                        target: Some(target),
                    }),
                    Link::Outside if eligible => excluded.outside_root += 1,
                    Link::Broken if eligible => excluded.broken_links += 1,
                    _ => {}
                }
                continue;
            }
            if !file_type.is_file() || !eligible {
                continue;
            }
            // `metadata` de uma entrada nao segue links e nao abre o arquivo:
            // um Markdown sem permissao de leitura continua no indice.
            match item.metadata() {
                Ok(meta) => {
                    let path = join_relative(&relative, &name);
                    if online_only(&meta) {
                        remote.insert(path.clone());
                    }
                    found.push(DocEntry {
                        relative: path,
                        size: meta.len(),
                        modified_ms: files::modified_ms(&meta),
                        symlink: false,
                        target: None,
                    });
                }
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
        let room = file_cap.saturating_sub(docs.len());
        if found.len() > room {
            // A pasta que estoura o teto entra em ordem de nome, para o
            // corte nao depender da ordem em que o disco lista.
            found.sort_by(|a, b| a.relative.cmp(&b.relative));
            found.truncate(room);
            stopped = Some("limit");
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
    let canonical_text = canonical_root.to_string_lossy().to_string();
    // O prazo das ligacoes nunca passa do que sobra do prazo da varredura.
    let deadline = [
        started.checked_add(options.time_budget),
        Instant::now().checked_add(options.link_time_budget),
    ]
    .into_iter()
    .flatten()
    .min();
    // A leitura parte da raiz canonica: no Windows ela e o caminho `\\?\`,
    // que nao passa pelos nomes reservados nem tira ponto e espaco do fim
    // dos nomes, e em todo sistema e a mesma raiz da chave do cache.
    let pass = link_pass(&LinkJob {
        docs: &docs,
        base: &canonical_root,
        root_key: &canonical_text,
        cache,
        options,
        deadline,
        cancel,
        remote: &remote,
        complete: stopped.is_none(),
    })?;
    let mut result = DocScan {
        key: String::new(),
        token: String::new(),
        root: requested.to_string_lossy().to_string(),
        canonical_root: canonical_text,
        scope: options.scope.as_str().to_string(),
        dirs: count_dirs(&docs),
        docs,
        links: pass.links,
        links_partial: pass.partial,
        links_read: pass.read,
        visited,
        elapsed_ms: started.elapsed().as_millis() as u64,
        partial: report.issues_total > 0 || stopped.is_some(),
        stopped: stopped.map(str::to_string),
        issues: report.issues,
        issues_total: report.issues_total,
        excluded,
        fingerprint: String::new(),
    };
    result.fingerprint = fingerprint_of(&result);
    Ok(result)
}

/* ── ligacoes: o que cada arquivo referencia ───────────────────────── */

/// Familias de arquivo de onde saem ligacoes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Markdown,
    /// MDX: Markdown com `import` de componentes.
    Mdx,
    Script,
    Style,
    Html,
    Python,
    Rust,
    Go,
    /// `go.mod`, lido so pela diretiva `module`.
    GoMod,
}

fn family_of(relative: &str) -> Option<Family> {
    let name = split_parent(relative).1;
    if name == "go.mod" {
        return Some(Family::GoMod);
    }
    let extension = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "md" | "markdown" => Family::Markdown,
        "mdx" => Family::Mdx,
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" => {
            Family::Script
        }
        "css" | "scss" | "sass" | "less" => Family::Style,
        "html" | "htm" => Family::Html,
        "py" => Family::Python,
        "rs" => Family::Rust,
        "go" => Family::Go,
        _ => return None,
    })
}

/// Uma referencia crua, como esta no arquivo. E isso que o cache guarda:
/// resolver contra a lista de arquivos e barato e muda a cada varredura.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Ref {
    /// Endereco de Markdown, HTML ou `url()`, sem `?` e `#` e decodificado.
    /// Relativo a pasta do arquivo, ou a raiz quando comeca por `/`.
    Url(String),
    /// `[[nota]]`, sem apelido e sem titulo.
    Wiki(String),
    /// Import relativo de JS e TS.
    Script(String),
    /// `@import`, `@use` e `@forward` de estilos.
    Style(String),
    /// Import de Python: pontos do import relativo, modulo e nomes do `from`.
    Python {
        level: usize,
        module: String,
        names: Vec<String>,
    },
    /// `mod x;` de Rust, com os modulos em linha que o envolvem.
    RustMod { inline: Arc<[String]>, name: String },
    /// Um caminho de `use` de Rust, com os modulos em linha que o envolvem.
    RustUse {
        inline: Arc<[String]>,
        path: Vec<String>,
    },
    /// Caminho importado por um arquivo Go.
    GoImport(String),
    /// Diretiva `module` de um `go.mod`.
    GoModule(String),
}

/// O que se sabe das referencias de um arquivo: `None` quando ele nao foi
/// lido.
type Slot = Option<Arc<[Ref]>>;

impl Ref {
    /// Bytes de texto que a referencia guarda, sem o custo das alocacoes.
    fn text_len(&self) -> usize {
        match self {
            Ref::Url(text)
            | Ref::Wiki(text)
            | Ref::Script(text)
            | Ref::Style(text)
            | Ref::GoImport(text)
            | Ref::GoModule(text) => text.len(),
            Ref::Python { module, names, .. } => {
                module.len() + names.iter().map(String::len).sum::<usize>()
            }
            Ref::RustMod { inline, name } => {
                name.len() + inline.iter().map(String::len).sum::<usize>()
            }
            Ref::RustUse { inline, path } => inline.iter().chain(path).map(String::len).sum(),
        }
    }

    /// Textos alocados dentro da referencia.
    fn texts(&self) -> usize {
        match self {
            Ref::Url(_)
            | Ref::Wiki(_)
            | Ref::Script(_)
            | Ref::Style(_)
            | Ref::GoImport(_)
            | Ref::GoModule(_) => 1,
            Ref::Python { names, .. } => 1 + names.len(),
            Ref::RustMod { inline, .. } => 1 + inline.len(),
            Ref::RustUse { inline, path } => inline.len() + path.len(),
        }
    }

    /// Memoria aproximada da referencia: o texto mais [`REF_OVERHEAD`] pela
    /// propria referencia e por texto alocado. Mil nomes de uma letra pesam
    /// como as mil alocacoes que sao, nao como mil bytes. E o que contam o
    /// teto por arquivo, o da varredura e o orcamento do cache.
    fn weight(&self) -> usize {
        self.text_len() + REF_OVERHEAD * (1 + self.texts())
    }
}

/// Peso de uma lista de referencias, com o da propria lista.
fn weight_of(refs: &[Ref]) -> usize {
    REF_OVERHEAD + refs.iter().map(Ref::weight).sum::<usize>()
}

/// Referencias de um arquivo, com teto de quantidade e de peso: um arquivo
/// patologico nao enche o cache.
#[derive(Default)]
struct Refs {
    items: Vec<Ref>,
    bytes: usize,
}

impl Refs {
    fn push(&mut self, reference: Ref) {
        let weight = reference.weight();
        // Um `from x import (...)` longo e legitimo; caminho desse tamanho, nao.
        let oversized =
            reference.text_len() > PATH_LIMIT && !matches!(reference, Ref::Python { .. });
        if !oversized
            && self.items.len() < REFS_PER_FILE
            && self.bytes + weight <= REF_BYTES_PER_FILE
        {
            self.bytes += weight;
            self.items.push(reference);
        }
    }

    /// Quantas referencias ainda cabem, no maximo: cada uma pesa ao menos o
    /// custo de duas alocacoes.
    fn room(&self) -> usize {
        let by_count = REFS_PER_FILE.saturating_sub(self.items.len());
        let by_weight = REF_BYTES_PER_FILE.saturating_sub(self.bytes) / (2 * REF_OVERHEAD);
        by_count.min(by_weight)
    }

    /// Endereco de Markdown, HTML ou `url()`. O que aponta para fora some.
    fn url(&mut self, raw: &str) {
        if let Some(path) = clean_url(raw) {
            self.push(Ref::Url(path));
        }
    }

    fn wiki(&mut self, raw: &str) {
        let target = raw.trim();
        if !target.is_empty() {
            self.push(Ref::Wiki(target.to_string()));
        }
    }

    /// Import de JS e TS: so caminho relativo ou a partir da raiz. Pacote do
    /// `node_modules` nao vira ligacao.
    fn script(&mut self, specifier: &str) {
        let relative = matches!(specifier, "." | "..")
            || specifier.starts_with("./")
            || specifier.starts_with("../")
            || (specifier.starts_with('/') && !specifier.starts_with("//"));
        if relative {
            let path = specifier.split(['?', '#']).next().unwrap_or_default();
            self.push(Ref::Script(path.to_string()));
        }
    }

    /// `@import` e afins. Pacote (`~`), modulo embutido (`sass:math`) e
    /// endereco externo ficam de fora.
    fn style(&mut self, value: &str) {
        let value = value.trim();
        if value.is_empty()
            || value.starts_with('~')
            || value.starts_with("//")
            || has_scheme(value)
        {
            return;
        }
        let path = value.split(['?', '#']).next().unwrap_or_default();
        if !path.is_empty() {
            self.push(Ref::Style(path.to_string()));
        }
    }
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Byte de identificador. Fora do ASCII conta como letra.
fn is_ident_byte(byte: u8) -> bool {
    is_word_byte(byte) || byte == b'$' || byte >= 0x80
}

/// `text` sem a palavra-chave do comeco, se ela estiver ali inteira.
fn strip_keyword<'t>(text: &'t str, keyword: &str) -> Option<&'t str> {
    let rest = text.strip_prefix(keyword)?;
    match rest.bytes().next() {
        Some(byte) if is_ident_byte(byte) => None,
        _ => Some(rest),
    }
}

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_alphabetic())
        && chars.all(|character| character == '_' || character.is_alphanumeric())
}

fn run_of(text: &str, mark: u8) -> usize {
    text.bytes().take_while(|&byte| byte == mark).count()
}

/// O comeco de `text`, ate [`SPEC_LIMIT`] bytes sem cortar caractere. Nenhum
/// caminho de verdade passa disso, e o teto impede que uma linha enorme e sem
/// fecho faca cada ocorrencia varrer o resto do arquivo.
fn head(text: &str) -> &str {
    if text.len() <= SPEC_LIMIT {
        return text;
    }
    let mut end = SPEC_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// O trecho de `text` ate o primeiro caractere que `ends` aceita. Sem esse
/// fim dentro de [`SPEC_LIMIT`], so vale se a linha acabou antes.
fn token_until(text: &str, ends: impl Fn(char) -> bool) -> Option<&str> {
    let window = head(text);
    match window.find(ends) {
        Some(end) => Some(&window[..end]),
        None if window.len() == text.len() => Some(window),
        None => None,
    }
}

/// Le a string entre aspas simples, duplas ou crases do comeco de `text`.
/// Devolve o conteudo e quantos bytes ela ocupa. Crase com `${}` nao e um
/// caminho fixo e fica de fora, assim como string sem fecho ate
/// [`SPEC_LIMIT`].
fn string_literal(text: &str) -> Option<(String, usize)> {
    let quote = text.chars().next()?;
    if !matches!(quote, '\'' | '"' | '`') {
        return None;
    }
    let mut value = String::new();
    let mut escaped = false;
    for (index, character) in head(text).char_indices().skip(1) {
        if escaped {
            value.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == quote {
            if quote == '`' && value.contains("${") {
                return None;
            }
            return Some((value, index + 1));
        } else if character == '\n' && quote != '`' {
            return None;
        } else {
            value.push(character);
        }
    }
    None
}

/// `http:`, `mailto:`, `data:`, `sass:` e afins. Letra de unidade do Windows
/// tambem cai aqui, e e o certo: caminho absoluto nao e da raiz.
fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|character| character.is_ascii_alphanumeric() || "+-.".contains(character))
}

fn percent_decode(text: &str) -> Cow<'_, str> {
    if !text.contains('%') {
        return Cow::Borrowed(text);
    }
    let hex = |byte: u8| (byte as char).to_digit(16);
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).and_then(|&byte| hex(byte));
            let low = bytes.get(index + 2).and_then(|&byte| hex(byte));
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    match String::from_utf8(decoded) {
        Ok(text) => Cow::Owned(text),
        Err(_) => Cow::Borrowed(text),
    }
}

/// Endereco local: sem esquema, sem `?` e `#`, decodificado e com `/`.
/// Ancora da propria pagina e endereco externo viram `None`.
fn clean_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with('#') || has_scheme(raw) {
        return None;
    }
    let end = raw.find(['?', '#']).unwrap_or(raw.len());
    let path = percent_decode(&raw[..end]).replace('\\', "/");
    (!path.is_empty() && !path.starts_with("//")).then_some(path)
}

/// Barra invertida antes de pontuacao e escape no Markdown.
fn unescape_markdown(text: &str) -> Cow<'_, str> {
    if !text.contains('\\') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' {
            if let Some(&next) = chars.peek().filter(|next| next.is_ascii_punctuation()) {
                out.push(next);
                chars.next();
                continue;
            }
        }
        out.push(character);
    }
    Cow::Owned(out)
}

fn extract_refs(family: Family, text: &str) -> Vec<Ref> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut refs = Refs::default();
    match family {
        Family::Markdown => markdown_refs(text, false, &mut refs),
        Family::Mdx => markdown_refs(text, true, &mut refs),
        Family::Script => script_refs(text, &mut refs),
        Family::Style => style_refs(text, &mut refs),
        Family::Html => html_refs(text, &mut refs),
        Family::Python => python_refs(text, &mut refs),
        Family::Rust => rust_refs(text, &mut refs),
        Family::Go => go_refs(text, &mut refs),
        Family::GoMod => go_module_refs(text, &mut refs),
    }
    refs.items
}

/* ── Markdown e HTML ── */

/// Markdown: links e imagens em linha, definicoes de referencia, wikilinks e
/// `src` e `href` do HTML embutido. Bloco cercado, bloco recuado, comentario
/// HTML e codigo em linha ficam de fora. No MDX, as linhas de `import` e
/// `export` sao lidas como JS.
fn markdown_refs(text: &str, mdx: bool, out: &mut Refs) {
    let mut fence: Option<(u8, usize)> = None;
    // Comentario `<!--` aberto numa linha anterior.
    let mut comment = false;
    // Bloco de codigo recuado aberto.
    let mut indented = false;
    // A linha anterior era vazia; o comeco do texto conta como vazia.
    let mut after_blank = true;
    // Dentro de um item de lista, onde linha recuada continua o item. Na
    // duvida fica ligado: ler um trecho de codigo custa menos que perder a
    // continuacao de um item.
    let mut in_list = false;
    for line in text.lines() {
        let trimmed = line.trim_start_matches(' ');
        let shallow = line.len() - trimmed.len() <= 3;
        if let Some((mark, size)) = fence {
            let run = run_of(trimmed, mark);
            if shallow && run >= size && trimmed[run..].trim().is_empty() {
                fence = None;
            }
            after_blank = false;
            continue;
        }
        // Na linha que fecha um comentario so conta o que vem depois do
        // `-->`, e essa sobra nunca abre bloco.
        let mut body = line;
        if comment {
            let Some(end) = line.find("-->") else {
                after_blank = false;
                continue;
            };
            comment = false;
            body = &line[end + 3..];
        }
        let blank = body.trim().is_empty();
        if body.len() == line.len() {
            let columns = indent_columns(line);
            if indented && (blank || columns >= 4) {
                after_blank = blank;
                continue;
            }
            indented = false;
            // Bloco recuado so comeca depois de linha vazia: colado num
            // paragrafo, o recuo continua o paragrafo.
            if !blank && columns >= 4 && after_blank && !in_list {
                indented = true;
                after_blank = false;
                continue;
            }
            if shallow {
                if let Some(opened) = fence_open(trimmed) {
                    fence = Some(opened);
                    after_blank = false;
                    continue;
                }
            }
            if !blank {
                if columns <= 3 && list_item(line) {
                    in_list = true;
                } else if columns == 0 && after_blank {
                    in_list = false;
                }
            }
            if mdx && (trimmed.starts_with("import ") || trimmed.starts_with("export ")) {
                script_line(trimmed, out);
                after_blank = false;
                continue;
            }
        }
        after_blank = blank;
        let visible = strip_code_spans(body);
        let visible = strip_comments(&visible, &mut comment);
        reference_definition(&visible, out);
        inline_links(&visible, out);
        wikilinks(&visible, out);
        html_attributes(&visible, out);
    }
}

/// Colunas do recuo, com tabulacao a cada quatro.
fn indent_columns(line: &str) -> usize {
    let mut columns = 0;
    for byte in line.bytes() {
        match byte {
            b' ' => columns += 1,
            b'\t' => columns += 4 - columns % 4,
            _ => break,
        }
    }
    columns
}

/// Linha que abre item de lista: `-`, `*` ou `+`, ou um numero com `.` ou
/// `)`, seguidos de espaco ou do fim da linha.
fn list_item(line: &str) -> bool {
    let bytes = line.trim_start_matches([' ', '\t']).as_bytes();
    let marker = match bytes.first() {
        Some(b'-' | b'*' | b'+') => 1,
        Some(byte) if byte.is_ascii_digit() => {
            let digits = bytes
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digits > 9 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return false;
            }
            digits + 1
        }
        _ => return false,
    };
    matches!(bytes.get(marker), None | Some(b' ' | b'\t'))
}

/// Tira cada `<!-- ... -->` da linha, trocando por um espaco. Comentario sem
/// fecho liga `open`: as linhas seguintes ficam de fora ate o `-->`.
fn strip_comments<'t>(line: &'t str, open: &mut bool) -> Cow<'t, str> {
    let Some(first) = line.find("<!--") else {
        return Cow::Borrowed(line);
    };
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    let mut start = first;
    loop {
        out.push_str(&rest[..start]);
        out.push(' ');
        let inside = &rest[start + 4..];
        // `<!-->` e `<!--->` ja fecham, como no CommonMark.
        let close = if inside.starts_with('>') {
            Some(1)
        } else if inside.starts_with("->") {
            Some(2)
        } else {
            inside.find("-->").map(|end| end + 3)
        };
        let Some(close) = close else {
            *open = true;
            return Cow::Owned(out);
        };
        rest = &inside[close..];
        match rest.find("<!--") {
            Some(next) => start = next,
            None => {
                out.push_str(rest);
                return Cow::Owned(out);
            }
        }
    }
}

/// Abertura de bloco cercado: tres ou mais crases ou tils.
fn fence_open(text: &str) -> Option<(u8, usize)> {
    let mark = *text.as_bytes().first()?;
    if mark != b'`' && mark != b'~' {
        return None;
    }
    let size = run_of(text, mark);
    // Outra crase na linha de abertura faria dela codigo em linha.
    if size < 3 || (mark == b'`' && text[size..].contains('`')) {
        return None;
    }
    Some((mark, size))
}

/// Troca cada trecho de codigo em linha por um espaco. Uma sequencia de
/// crases fecha na proxima de mesmo tamanho; crase sem par fica como texto.
/// Uma passada so, com uma fila por tamanho: linha cheia de crases soltas
/// nao vira busca quadratica.
fn strip_code_spans(line: &str) -> Cow<'_, str> {
    if !line.contains('`') {
        return Cow::Borrowed(line);
    }
    let bytes = line.as_bytes();
    // Cada sequencia de crases: comeco e tamanho.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let size = run_of(&line[index..], b'`');
            runs.push((index, size));
            index += size;
        } else {
            index += 1;
        }
    }
    let mut by_size: HashMap<usize, VecDeque<usize>> = HashMap::new();
    for (position, (_, size)) in runs.iter().enumerate() {
        by_size.entry(*size).or_default().push_back(position);
    }
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    let mut position = 0;
    while position < runs.len() {
        let (start, size) = runs[position];
        let queue = by_size.entry(size).or_default();
        while queue.front().is_some_and(|&queued| queued <= position) {
            queue.pop_front();
        }
        match queue.front().copied() {
            Some(close) => {
                let (close_start, close_size) = runs[close];
                out.push_str(&line[copied..start]);
                out.push(' ');
                copied = close_start + close_size;
                position = close + 1;
            }
            None => position += 1,
        }
    }
    out.push_str(&line[copied..]);
    Cow::Owned(out)
}

/// `[texto](destino "titulo")` e `![alt](destino)`.
fn inline_links(line: &str, out: &mut Refs) {
    let mut rest = line;
    while let Some(at) = rest.find("](") {
        rest = &rest[at + 2..];
        if let Some(destination) = link_destination(rest) {
            out.url(&destination);
        }
    }
}

/// Destino de um link em linha: entre `<>` ou ate o espaco ou o `)` que
/// fecha, com parenteses equilibrados. Colchete solto encerra sem link: fora
/// do `<>` ele quase nunca e de um caminho, e assim uma linha cheia de `](`
/// nao faz cada ocorrencia varrer a janela inteira.
fn link_destination(text: &str) -> Option<String> {
    let text = head(text.trim_start_matches([' ', '\t']));
    if let Some(inner) = text.strip_prefix('<') {
        let end = inner.find('>')?;
        return Some(unescape_markdown(&inner[..end]).into_owned());
    }
    let mut depth = 0usize;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '[' | ']' => return None,
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            ')' | ' ' | '\t' => {
                let raw = &text[..index];
                return (!raw.is_empty()).then(|| unescape_markdown(raw).into_owned());
            }
            _ => {}
        }
    }
    None
}

/// `[rotulo]: destino` no comeco da linha. Nota de rodape, `[^1]:`, nao e
/// link.
fn reference_definition(line: &str, out: &mut Refs) {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return;
    }
    let Some(rest) = trimmed.strip_prefix('[') else {
        return;
    };
    if rest.starts_with(['^', '[']) {
        return;
    }
    let Some(close) = rest.find("]:") else {
        return;
    };
    if rest[..close].contains(['[', ']']) {
        return;
    }
    let value = rest[close + 2..].trim_start();
    let destination = match value.strip_prefix('<') {
        Some(inner) => inner.split('>').next().unwrap_or_default(),
        None => value.split_whitespace().next().unwrap_or_default(),
    };
    if !destination.is_empty() {
        out.url(&unescape_markdown(destination));
    }
}

/// `[[nota]]`, `[[nota|apelido]]`, `[[nota#titulo]]` e `![[imagem.png]]`.
fn wikilinks(line: &str, out: &mut Refs) {
    let mut rest = line;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else {
            break;
        };
        let inner = &after[..close];
        if !inner.contains('[') {
            // Dentro de tabela o `|` vem escapado: `[[nota\|apelido]]`.
            let target = inner.split('|').next().unwrap_or_default();
            let target = target.strip_suffix('\\').unwrap_or(target);
            out.wiki(target.split('#').next().unwrap_or_default());
        }
        rest = &after[close + 2..];
    }
}

/// HTML: `src` e `href` fora de comentario, inclusive o de varias linhas.
fn html_refs(text: &str, out: &mut Refs) {
    let mut comment = false;
    for line in text.lines() {
        let mut body = line;
        if comment {
            let Some(end) = line.find("-->") else {
                continue;
            };
            comment = false;
            body = &line[end + 3..];
        }
        html_attributes(&strip_comments(body, &mut comment), out);
    }
}

/// `src=` e `href=`, com ou sem aspas. `data-src` tambem vale; `srcset`, nao.
/// Valor sem aspas termina onde o HTML manda: espaco, `>`, aspas, `=`, `<` ou
/// crase.
fn html_attributes(line: &str, out: &mut Refs) {
    if !line.contains('=') {
        return;
    }
    // Minusculas so no ASCII: as posicoes continuam as mesmas da linha.
    let lower = line.to_ascii_lowercase();
    for attribute in ["src", "href"] {
        let mut cursor = 0;
        while let Some(found) = lower[cursor..].find(attribute) {
            let at = cursor + found;
            cursor = at + attribute.len();
            if at > 0 && is_word_byte(lower.as_bytes()[at - 1]) {
                continue;
            }
            let Some(value) = line[cursor..].trim_start().strip_prefix('=') else {
                continue;
            };
            let value = value.trim_start();
            let destination = match value.as_bytes().first() {
                Some(&quote) if quote == b'"' || quote == b'\'' => {
                    let inner = head(&value[1..]);
                    inner.find(quote as char).map(|end| &inner[..end])
                }
                Some(_) => token_until(value, |character| {
                    character.is_whitespace() || "\"'=<>`".contains(character)
                }),
                None => None,
            };
            if let Some(destination) = destination {
                out.url(destination);
            }
        }
    }
}

/* ── JS, TS e estilos ── */

/// JS e TS: `import ... from`, `import 'x'`, `export ... from`, `require()` e
/// `import()`, so com caminho relativo. Linha e bloco de comentario ficam de
/// fora.
fn script_refs(text: &str, out: &mut Refs) {
    let mut comment = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if comment {
            comment = !trimmed.contains("*/");
            continue;
        }
        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            comment = !rest.contains("*/");
            continue;
        }
        script_line(trimmed, out);
    }
}

fn script_line(line: &str, out: &mut Refs) {
    if !line.contains(['\'', '"', '`']) {
        return;
    }
    let bytes = line.as_bytes();
    for keyword in ["from", "import", "require"] {
        let mut cursor = 0;
        while let Some(found) = line[cursor..].find(keyword) {
            let at = cursor + found;
            cursor = at + keyword.len();
            // `Array.from(...)` e `fromage` nao sao import.
            if at > 0 && (is_ident_byte(bytes[at - 1]) || bytes[at - 1] == b'.') {
                continue;
            }
            if bytes.get(cursor).is_some_and(|&byte| is_ident_byte(byte)) {
                continue;
            }
            let mut rest = line[cursor..].trim_start();
            if keyword != "from" {
                match rest.strip_prefix('(') {
                    Some(inner) => rest = inner.trim_start(),
                    None if keyword == "require" => continue,
                    None => {}
                }
            }
            if let Some((specifier, _)) = string_literal(rest) {
                out.script(&specifier);
            }
        }
    }
}

/// Estilos: `@import`, `@use` e `@forward` resolvem como no Sass; `url()`,
/// como endereco.
fn style_refs(text: &str, out: &mut Refs) {
    let mut comment = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if comment {
            comment = !trimmed.contains("*/");
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            comment = !rest.contains("*/");
            continue;
        }
        style_line(trimmed, out);
    }
}

fn style_line(line: &str, out: &mut Refs) {
    for directive in ["@import", "@use", "@forward"] {
        let mut cursor = 0;
        while let Some(found) = line[cursor..].find(directive) {
            cursor += found + directive.len();
            if line
                .as_bytes()
                .get(cursor)
                .is_some_and(|&byte| is_word_byte(byte) || byte == b'-')
            {
                continue;
            }
            let mut rest = line[cursor..].trim_start();
            if string_literal(rest).is_none() {
                // Sass sem aspas, `@import base`. `url()` fica para a busca
                // de baixo.
                let token = token_until(rest, |character| {
                    character.is_whitespace() || character == ';' || character == ','
                })
                .unwrap_or_default();
                if !token
                    .get(..4)
                    .is_some_and(|start| start.eq_ignore_ascii_case("url("))
                {
                    out.style(token);
                }
                continue;
            }
            // Uma ou mais strings separadas por virgula.
            while let Some((value, used)) = string_literal(rest) {
                out.style(&value);
                rest = rest[used..].trim_start();
                match rest.strip_prefix(',') {
                    Some(next) => rest = next.trim_start(),
                    None => break,
                }
            }
        }
    }
    url_functions(line, out);
}

/// `url(x)`, `url('x')` e `url("x")`.
fn url_functions(line: &str, out: &mut Refs) {
    let lower = line.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("url(") {
        let at = cursor + found;
        cursor = at + 4;
        if at > 0 && {
            let before = lower.as_bytes()[at - 1];
            is_word_byte(before) || before == b'-'
        } {
            continue;
        }
        let rest = head(line[cursor..].trim_start());
        match string_literal(rest) {
            Some((value, _)) => out.url(&value),
            None => {
                if let Some((value, _)) = rest.split_once(')') {
                    out.url(value);
                }
            }
        }
    }
}

/* ── Python ── */

/// Python: `import a.b` e `from .a import b`, inclusive com parenteses ou
/// barra no fim da linha. Docstring fica de fora.
fn python_refs(text: &str, out: &mut Refs) {
    let mut lines = text.lines();
    let mut docstring: Option<&str> = None;
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if let Some(quote) = docstring {
            if trimmed.contains(quote) {
                docstring = None;
            }
            continue;
        }
        // Numero impar de aspas triplas abre uma docstring que segue abaixo.
        if let Some(quote) = ["\"\"\"", "'''"]
            .into_iter()
            .find(|quote| trimmed.matches(*quote).count() % 2 == 1)
        {
            docstring = Some(quote);
            continue;
        }
        if !(trimmed.starts_with("import ") || trimmed.starts_with("from ")) {
            continue;
        }
        let mut statement = python_code(trimmed).to_string();
        let mut extra = 0;
        while extra < 64
            && (statement.ends_with('\\')
                || statement.matches('(').count() > statement.matches(')').count())
        {
            let Some(next) = lines.next() else {
                break;
            };
            if statement.ends_with('\\') {
                statement.pop();
            }
            statement.push(' ');
            statement.push_str(python_code(next.trim()));
            extra += 1;
        }
        python_statement(&statement, out);
    }
}

fn python_code(line: &str) -> &str {
    line.split('#').next().unwrap_or_default().trim_end()
}

fn is_dotted(text: &str) -> bool {
    !text.is_empty() && text.split('.').all(is_identifier)
}

fn python_statement(statement: &str, out: &mut Refs) {
    if let Some(rest) = statement.strip_prefix("import ") {
        for part in rest.split(',') {
            let module = part.split_whitespace().next().unwrap_or_default();
            if is_dotted(module) {
                out.push(Ref::Python {
                    level: 0,
                    module: module.to_string(),
                    names: Vec::new(),
                });
            }
        }
        return;
    }
    let Some(rest) = statement.strip_prefix("from ") else {
        return;
    };
    let Some((origin, names)) = rest.split_once(" import ") else {
        return;
    };
    let origin = origin.trim();
    let level = run_of(origin, b'.');
    let module = &origin[level..];
    if (level == 0 || !module.is_empty()) && !is_dotted(module) {
        return;
    }
    let mut names: Vec<String> = names
        .replace(['(', ')'], " ")
        .split(',')
        .filter_map(|part| part.split_whitespace().next())
        .filter(|name| *name == "*" || is_identifier(name))
        .take(PYTHON_NAMES_LIMIT + 1)
        .map(str::to_string)
        .collect();
    if names.len() > PYTHON_NAMES_LIMIT {
        // O resto nao cabe. Como num `import *`, o modulo ainda liga.
        names.truncate(PYTHON_NAMES_LIMIT - 1);
        names.push("*".to_string());
    }
    out.push(Ref::Python {
        level,
        module: module.to_string(),
        names,
    });
}

/* ── Rust ── */

/// Copia do codigo Rust com comentario e miolo de string e de char trocados
/// por espaco, para contar chaves sem tropecar em `'{'` ou `"}"`. As quebras
/// de linha ficam.
fn rust_code(text: &str) -> String {
    let bytes = text.as_bytes();
    let blank = |byte: u8| if byte == b'\n' { b'\n' } else { b' ' };
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if byte == b'/' && next == Some(b'/') {
            while index < bytes.len() && bytes[index] != b'\n' {
                out.push(b' ');
                index += 1;
            }
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            // Comentario de bloco aninha em Rust.
            let mut depth = 0usize;
            while index < bytes.len() {
                let pair = (bytes[index], bytes.get(index + 1).copied());
                if pair == (b'/', Some(b'*')) {
                    depth += 1;
                    out.extend_from_slice(b"  ");
                    index += 2;
                } else if pair == (b'*', Some(b'/')) {
                    depth -= 1;
                    out.extend_from_slice(b"  ");
                    index += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    out.push(blank(bytes[index]));
                    index += 1;
                }
            }
            continue;
        }
        if let Some(hashes) = raw_string_hashes(bytes, index) {
            let open = index + hashes + 2;
            out.extend_from_slice(&bytes[index..open]);
            index = open;
            while index < bytes.len() {
                let closes = bytes[index] == b'"'
                    && bytes
                        .get(index + 1..index + 1 + hashes)
                        .is_some_and(|tail| tail.iter().all(|&byte| byte == b'#'));
                if closes {
                    out.extend_from_slice(&bytes[index..index + 1 + hashes]);
                    index += 1 + hashes;
                    break;
                }
                out.push(blank(bytes[index]));
                index += 1;
            }
            continue;
        }
        if byte == b'"' {
            out.push(b'"');
            index += 1;
            while index < bytes.len() {
                match bytes[index] {
                    b'\\' => {
                        out.push(b' ');
                        index += 1;
                        if let Some(&escaped) = bytes.get(index) {
                            out.push(blank(escaped));
                            index += 1;
                        }
                    }
                    b'"' => {
                        out.push(b'"');
                        index += 1;
                        break;
                    }
                    other => {
                        out.push(blank(other));
                        index += 1;
                    }
                }
            }
            continue;
        }
        if byte == b'\'' {
            if let Some(size) = char_literal_size(&bytes[index..]) {
                out.push(b'\'');
                out.extend(std::iter::repeat_n(b' ', size - 2));
                out.push(b'\'');
                index += size;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// String crua que comeca em `index`, no `r` de `r"`, `r#"`, `br"` ou
/// `cr"`. Devolve quantos `#` ela usa.
fn raw_string_hashes(bytes: &[u8], index: usize) -> Option<usize> {
    if bytes[index] != b'r' {
        return None;
    }
    if index > 0 {
        let before = bytes[index - 1];
        let prefix =
            matches!(before, b'b' | b'c') && (index < 2 || !is_ident_byte(bytes[index - 2]));
        if is_ident_byte(before) && !prefix {
            return None;
        }
    }
    let hashes = bytes[index + 1..]
        .iter()
        .take_while(|&&byte| byte == b'#')
        .count();
    (bytes.get(index + 1 + hashes) == Some(&b'"')).then_some(hashes)
}

/// Tamanho de um char como `'x'`, `'\n'` ou `'\u{..}'`. Lifetime e label,
/// como `'a`, nao fecham e dao `None`.
fn char_literal_size(bytes: &[u8]) -> Option<usize> {
    let first = *bytes.get(1)?;
    if first == b'\\' {
        let close = bytes
            .iter()
            .skip(3)
            .take(10)
            .position(|&byte| byte == b'\'')?;
        return Some(close + 4);
    }
    let width = match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    };
    (bytes.get(1 + width) == Some(&b'\'')).then_some(width + 2)
}

/// Rust: `mod x;` e os caminhos de `use`, com os modulos em linha em volta,
/// porque `super` dentro de `mod tests { }` aponta para o proprio arquivo.
fn rust_refs(text: &str, out: &mut Refs) {
    let code = rust_code(text);
    let mut depth = 0usize;
    // Modulos em linha abertos: nome e profundidade do corpo.
    let mut inline: Vec<(String, usize)> = Vec::new();
    // O prefixo que esses modulos formam, refeito so quando a pilha muda e
    // dividido por todas as referencias de dentro deles.
    let mut prefix = inline_prefix(&inline);
    let mut lines = code.lines();
    while let Some(line) = lines.next() {
        let item = rust_item(line);
        if let Some(rest) = strip_keyword(item, "use") {
            let mut statement = rest.to_string();
            let mut closed = rest.contains(';');
            let mut extra = 0;
            while !closed && extra < 256 {
                let Some(next) = lines.next() else {
                    break;
                };
                statement.push(' ');
                statement.push_str(next);
                closed = next.contains(';');
                extra += 1;
            }
            if let Some(names) = &prefix {
                let tree = statement.split(';').next().unwrap_or_default();
                for path in use_paths(tree, out.room()) {
                    out.push(Ref::RustUse {
                        inline: Arc::clone(names),
                        path,
                    });
                }
            }
            // As chaves de um `use` se fecham nele mesmo.
            continue;
        }
        if let Some(rest) = strip_keyword(item, "mod") {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix("r#").unwrap_or(rest);
            let end = rest
                .find(|character: char| !(character == '_' || character.is_alphanumeric()))
                .unwrap_or(rest.len());
            let (name, after) = rest.split_at(end);
            let after = after.trim_start();
            if !name.is_empty() && after.starts_with(';') {
                if let Some(names) = &prefix {
                    out.push(Ref::RustMod {
                        inline: Arc::clone(names),
                        name: name.to_string(),
                    });
                }
            } else if !name.is_empty() && after.starts_with('{') {
                // Alem do teto o nome nao serve mais: a pilha so conta chaves.
                let name = if inline.len() < INLINE_DEPTH_LIMIT {
                    name.to_string()
                } else {
                    String::new()
                };
                inline.push((name, depth + 1));
                prefix = inline_prefix(&inline);
            }
        }
        for byte in line.bytes() {
            match byte {
                b'{' => depth += 1,
                b'}' => {
                    depth = depth.saturating_sub(1);
                    let open = inline.len();
                    while inline.last().is_some_and(|(_, body)| *body > depth) {
                        inline.pop();
                    }
                    if inline.len() != open {
                        prefix = inline_prefix(&inline);
                    }
                }
                _ => {}
            }
        }
    }
}

/// O prefixo dos modulos em linha abertos. `None` quando passa de
/// [`INLINE_DEPTH_LIMIT`] modulos ou de [`PATH_LIMIT`] bytes: nada ali dentro
/// vira referencia, e o custo nao cresce com a pilha.
fn inline_prefix(inline: &[(String, usize)]) -> Option<Arc<[String]>> {
    if inline.len() > INLINE_DEPTH_LIMIT {
        return None;
    }
    let bytes: usize = inline.iter().map(|(name, _)| name.len()).sum();
    (bytes <= PATH_LIMIT).then(|| inline.iter().map(|(name, _)| name.clone()).collect())
}

/// Tira atributos e visibilidade do comeco de uma linha de codigo Rust.
fn rust_item(line: &str) -> &str {
    let mut rest = line.trim_start();
    while rest.starts_with("#[") || rest.starts_with("#![") {
        let mut depth = 0usize;
        let mut end = None;
        for (index, byte) in rest.bytes().enumerate() {
            match byte {
                b'[' => depth += 1,
                b']' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            return "";
        };
        rest = rest[end + 1..].trim_start();
    }
    if let Some(after) = strip_keyword(rest, "pub") {
        let after = after.trim_start();
        rest = match after.strip_prefix('(') {
            Some(inner) => inner
                .find(')')
                .map_or("", |close| inner[close + 1..].trim_start()),
            None => after,
        };
    }
    rest
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UseToken<'t> {
    Name(&'t str),
    Path,
    Open,
    Close,
    Comma,
    Star,
    As,
}

/// Os tokens de um `use`, ou `None` acima de [`USE_TOKEN_LIMIT`].
fn use_tokens(text: &str) -> Option<Vec<UseToken<'_>>> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let token = match byte {
            b':' if bytes.get(index + 1) == Some(&b':') => {
                index += 2;
                UseToken::Path
            }
            b'{' => {
                index += 1;
                UseToken::Open
            }
            b'}' => {
                index += 1;
                UseToken::Close
            }
            b',' => {
                index += 1;
                UseToken::Comma
            }
            b'*' => {
                index += 1;
                UseToken::Star
            }
            _ if is_ident_byte(byte) => {
                // `r#tipo` e um nome cru.
                if byte == b'r' && bytes.get(index + 1) == Some(&b'#') {
                    index += 2;
                }
                let start = index;
                while index < bytes.len() && is_ident_byte(bytes[index]) {
                    index += 1;
                }
                match &text[start..index] {
                    "as" => UseToken::As,
                    name => UseToken::Name(name),
                }
            }
            _ => {
                index += 1;
                continue;
            }
        };
        if tokens.len() == USE_TOKEN_LIMIT {
            return None;
        }
        tokens.push(token);
    }
    Some(tokens)
}

/// Caminhos de uma arvore de `use`, ja sem `as` e com os grupos abertos:
/// `crate::a::{self, b::c}` da `crate::a` e `crate::a::b::c`. Caminho que
/// comeca por `::` e de outra crate e fica de fora. Sai no maximo `room`
/// caminhos; instrucao com mais de [`USE_TOKEN_LIMIT`] tokens e ignorada, e a
/// que tem caminho de mais de [`USE_SEGMENT_LIMIT`] segmentos ou copiaria mais
/// de [`USE_COPY_LIMIT`] bytes ao abrir grupos para no ponto em que passou.
/// Os tetos valem antes de copiar: grupo enorme sob prefixo longo nao
/// multiplica memoria.
fn use_paths(tree: &str, room: usize) -> Vec<Vec<String>> {
    if room == 0 {
        return Vec::new();
    }
    let Some(tokens) = use_tokens(tree) else {
        return Vec::new();
    };
    let mut walk = UseWalk {
        tokens: &tokens,
        position: 0,
        paths: Vec::new(),
        room,
        copies: USE_COPY_LIMIT,
    };
    walk.tree(Vec::new(), 0);
    walk.paths
}

/// Percurso dos tokens de um `use`, com os tetos de [`use_paths`].
struct UseWalk<'t, 's> {
    tokens: &'t [UseToken<'s>],
    position: usize,
    paths: Vec<Vec<String>>,
    /// Caminhos que ainda cabem.
    room: usize,
    /// Bytes que ainda podem ser copiados ao abrir grupos.
    copies: usize,
}

impl UseWalk<'_, '_> {
    /// Encerra a instrucao: todo laco acima ve o fim dos tokens.
    fn stop(&mut self) {
        self.position = self.tokens.len();
    }

    fn finish(&mut self, path: Vec<String>) {
        self.paths.push(path);
        self.room -= 1;
        if self.room == 0 {
            self.stop();
        }
    }

    fn tree(&mut self, mut path: Vec<String>, depth: usize) {
        if depth > 16 {
            return;
        }
        let base = path.len();
        loop {
            match self.tokens.get(self.position).copied() {
                Some(UseToken::Name(name)) => {
                    self.position += 1;
                    // `self` dentro de chaves e o proprio prefixo.
                    if !(name == "self" && base > 0 && path.len() == base) {
                        if path.len() == USE_SEGMENT_LIMIT {
                            self.stop();
                            return;
                        }
                        path.push(name.to_string());
                    }
                    match self.tokens.get(self.position) {
                        Some(UseToken::Path) => {
                            self.position += 1;
                            continue;
                        }
                        Some(UseToken::As) => {
                            self.position += 1;
                            if matches!(self.tokens.get(self.position), Some(UseToken::Name(_))) {
                                self.position += 1;
                            }
                        }
                        _ => {}
                    }
                    self.finish(path);
                    return;
                }
                Some(UseToken::Star) => {
                    self.position += 1;
                    self.finish(path);
                    return;
                }
                Some(UseToken::Open) => {
                    self.position += 1;
                    loop {
                        match self.tokens.get(self.position) {
                            None => return,
                            Some(UseToken::Close) => {
                                self.position += 1;
                                return;
                            }
                            Some(UseToken::Comma) => {
                                self.position += 1;
                                continue;
                            }
                            _ => {}
                        }
                        let cost: usize = path
                            .iter()
                            .map(|segment| segment.len() + REF_OVERHEAD)
                            .sum();
                        if self.copies < cost {
                            self.stop();
                            return;
                        }
                        self.copies -= cost;
                        let before = self.position;
                        self.tree(path.clone(), depth + 1);
                        if self.position == before {
                            return;
                        }
                    }
                }
                _ => return,
            }
        }
    }
}

/* ── Go ── */

/// Go: `import "x"`, `import nome "x"` e o bloco `import ( ... )`.
fn go_refs(text: &str, out: &mut Refs) {
    let mut block = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }
        if block {
            if trimmed.starts_with(')') {
                block = false;
            } else {
                go_import_spec(trimmed, out);
            }
            continue;
        }
        let Some(rest) = strip_keyword(trimmed, "import") else {
            continue;
        };
        let rest = rest.trim_start();
        match rest.strip_prefix('(') {
            Some(inner) => {
                let (inner, closed) = match inner.find(')') {
                    Some(end) => (&inner[..end], true),
                    None => (inner, false),
                };
                inner
                    .split(';')
                    .for_each(|part| go_import_spec(part.trim(), out));
                block = !closed;
            }
            None => go_import_spec(rest, out),
        }
    }
}

/// `nome "caminho"`, com ou sem o nome, em aspas ou crases.
fn go_import_spec(text: &str, out: &mut Refs) {
    let Some(start) = text.find(['"', '`']) else {
        return;
    };
    if let Some((path, _)) = string_literal(&text[start..]) {
        if !path.is_empty() {
            out.push(Ref::GoImport(path));
        }
    }
}

/// A diretiva `module` de um `go.mod`.
fn go_module_refs(text: &str, out: &mut Refs) {
    for line in text.lines() {
        let line = line.split("//").next().unwrap_or_default().trim();
        if let Some(rest) = strip_keyword(line, "module") {
            let module = rest.trim().trim_matches(['"', '`']);
            if !module.is_empty() {
                out.push(Ref::GoModule(module.to_string()));
            }
            return;
        }
    }
}

/* ── ligacoes: resolver contra a lista ─────────────────────────────── */

/// Pasta e nome de um caminho relativo. A raiz e a pasta vazia.
fn split_parent(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

fn parent_of(path: &str) -> &str {
    split_parent(path).0
}

/// Junta `relative` a `base`, resolvendo `.` e `..`. Sair da raiz da `None`.
fn join_path(base: &str, relative: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// Caminho com `/` no comeco parte da raiz; os demais, da pasta de `source`.
fn resolve_from(source: &str, path: &str) -> Option<String> {
    match path.strip_prefix('/') {
        Some(rest) => join_path("", rest),
        None => join_path(parent_of(source), path),
    }
}

/// A pasta mais proxima de `source`, subindo ate a raiz, que satisfaz `has`.
fn nearest(source: &str, has: impl Fn(&str) -> bool) -> Option<&str> {
    nearest_dir(parent_of(source), has)
}

/// A propria `folder` ou a primeira acima dela que satisfaz `has`.
fn nearest_dir(mut folder: &str, has: impl Fn(&str) -> bool) -> Option<&str> {
    loop {
        if has(folder) {
            return Some(folder);
        }
        if folder.is_empty() {
            return None;
        }
        folder = parent_of(folder);
    }
}

/// O resto do import depois do prefixo do modulo Go, sem a barra.
fn module_rest<'i>(import: &'i str, module: &str) -> Option<&'i str> {
    let rest = import.strip_prefix(module)?;
    if rest.is_empty() {
        Some(rest)
    } else {
        rest.strip_prefix('/')
    }
}

/// Wikilink com pasta, `[[docs/guia]]`, so casa com caminho que termina
/// nela.
fn wiki_suffix(relative: &str, wanted: &str) -> bool {
    if !wanted.contains('/') {
        return true;
    }
    let lower = relative.to_lowercase();
    let stem = match lower.rsplit_once('.') {
        Some((stem, _)) if is_markdown(&lower) => stem,
        _ => lower.as_str(),
    };
    [lower.as_str(), stem].into_iter().any(|path| {
        path == wanted
            || path
                .strip_suffix(wanted)
                .is_some_and(|head| head.ends_with('/'))
    })
}

const SCRIPT_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "vue", "svelte", "css",
];
const SCRIPT_INDEXES: &[&str] = &[
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
    "index.mjs",
];
const STYLE_EXTENSIONS: &[&str] = &["scss", "sass", "css", "less"];

/// Resolve referencias cruas contra a lista de arquivos da varredura.
struct Resolver<'a> {
    docs: &'a [DocEntry],
    index: HashMap<&'a str, u32>,
    /// Nome em minusculas, com e sem a extensao de Markdown, para wikilinks.
    /// So e montado quando ha wikilink.
    names: HashMap<String, Vec<u32>>,
    /// Pastas com `Cargo.toml`.
    crates: HashSet<&'a str>,
    /// Pastas com `pyproject.toml`, `setup.py` ou `setup.cfg`.
    python_roots: HashSet<&'a str>,
    /// Pasta de cada `go.mod` lido e o modulo que ele declara.
    go_modules: HashMap<&'a str, &'a str>,
    /// Arquivo que representa cada pacote Go, por pasta.
    go_packages: HashMap<&'a str, u32>,
    /// Bases do import absoluto de Python, uma vez por pasta de origem.
    python_bases: RefCell<HashMap<&'a str, Rc<[String]>>>,
}

impl<'a> Resolver<'a> {
    fn new(docs: &'a [DocEntry], sources: &[(usize, Family)], slots: &'a [Slot]) -> Self {
        let mut index = HashMap::with_capacity(docs.len());
        let mut crates = HashSet::new();
        let mut python_roots = HashSet::new();
        let mut go_files: HashMap<&str, Vec<(&str, u32)>> = HashMap::new();
        for (position, doc) in docs.iter().enumerate() {
            let position = position as u32;
            index.insert(doc.relative.as_str(), position);
            let (folder, name) = split_parent(&doc.relative);
            match name {
                "Cargo.toml" => {
                    crates.insert(folder);
                }
                "pyproject.toml" | "setup.py" | "setup.cfg" => {
                    python_roots.insert(folder);
                }
                _ if name.ends_with(".go") && !name.ends_with("_test.go") => {
                    go_files.entry(folder).or_default().push((name, position));
                }
                _ => {}
            }
        }
        let mut names: HashMap<String, Vec<u32>> = HashMap::new();
        let wants_names = slots.iter().flatten().any(|refs| {
            refs.iter()
                .any(|reference| matches!(reference, Ref::Wiki(_)))
        });
        if wants_names {
            for (position, doc) in docs.iter().enumerate() {
                let name = split_parent(&doc.relative).1.to_lowercase();
                if let Some((stem, _)) = name.rsplit_once('.').filter(|_| is_markdown(&name)) {
                    names
                        .entry(stem.to_string())
                        .or_default()
                        .push(position as u32);
                }
                names.entry(name).or_default().push(position as u32);
            }
        }
        let mut go_modules = HashMap::new();
        for ((position, family), slot) in sources.iter().zip(slots) {
            if *family != Family::GoMod {
                continue;
            }
            for reference in slot.iter().flat_map(|refs| refs.iter()) {
                if let Ref::GoModule(module) = reference {
                    go_modules.insert(parent_of(&docs[*position].relative), module.as_str());
                }
            }
        }
        // O pacote e representado pelo arquivo com o nome da pasta, pelo
        // `doc.go` ou pelo primeiro em ordem de nome.
        let go_packages = go_files
            .into_iter()
            .map(|(folder, files)| {
                let own = format!("{}.go", split_parent(folder).1);
                let pick = files
                    .iter()
                    .find(|(name, _)| *name == own)
                    .or_else(|| files.iter().find(|(name, _)| *name == "doc.go"))
                    .unwrap_or(&files[0]);
                (folder, pick.1)
            })
            .collect();
        Self {
            docs,
            index,
            names,
            crates,
            python_roots,
            go_modules,
            go_packages,
            python_bases: RefCell::default(),
        }
    }

    fn find(&self, path: &str) -> Option<u32> {
        self.index.get(path).copied()
    }

    /// Alvos de uma referencia. Python pode dar mais de um. Rust depende do
    /// proprio arquivo de origem; as demais, so da pasta dele.
    fn resolve(&self, source: &'a str, reference: &Ref, out: &mut Vec<u32>) {
        let found = match reference {
            Ref::Url(path) => self.url(source, path),
            Ref::Wiki(target) => self.wiki(source, target),
            Ref::Script(specifier) => self.script(source, specifier),
            Ref::Style(value) => self.style(source, value),
            Ref::Python {
                level,
                module,
                names,
            } => {
                self.python(source, *level, module, names, out);
                None
            }
            Ref::RustMod { inline, name } => self.rust_mod(source, inline, name),
            Ref::RustUse { inline, path } => self.rust_use(source, inline, path),
            Ref::GoImport(path) => self.go(source, path),
            Ref::GoModule(_) => None,
        };
        out.extend(found);
    }

    /// Endereco: o arquivo exato ou, para uma pasta, o README ou o index dela.
    fn url(&self, source: &str, path: &str) -> Option<u32> {
        let resolved = resolve_from(source, path)?;
        self.find(&resolved).or_else(|| {
            ["README.md", "readme.md", "index.md", "index.html"]
                .iter()
                .find_map(|name| self.find(&join_relative(&resolved, name)))
        })
    }

    /// Wikilink: caminho exato, com ou sem `.md`, a partir da pasta do arquivo
    /// e depois da raiz; senao, o unico arquivo com esse nome sem diferenciar
    /// caixa, preferindo a mesma pasta. Empate fica sem ligacao.
    fn wiki(&self, source: &str, target: &str) -> Option<u32> {
        let folder = parent_of(source);
        for base in [folder, ""] {
            let Some(path) = join_path(base, target) else {
                continue;
            };
            if let Some(found) = self
                .find(&path)
                .or_else(|| self.find(&format!("{path}.md")))
            {
                return Some(found);
            }
        }
        let wanted = target.trim_start_matches('/').to_lowercase();
        let matching: Vec<u32> = self
            .names
            .get(split_parent(&wanted).1)?
            .iter()
            .copied()
            .filter(|&found| wiki_suffix(&self.docs[found as usize].relative, &wanted))
            .collect();
        let same: Vec<u32> = matching
            .iter()
            .copied()
            .filter(|&found| parent_of(&self.docs[found as usize].relative) == folder)
            .collect();
        match (same.as_slice(), matching.as_slice()) {
            ([only], _) | ([], [only]) => Some(*only),
            _ => None,
        }
    }

    /// Import de JS e TS: exato, com extensao, `.js` trocado por `.ts` e, por
    /// fim, o `index` da pasta.
    fn script(&self, source: &str, specifier: &str) -> Option<u32> {
        let path = resolve_from(source, specifier)?;
        let folder_only = specifier.ends_with('/') || matches!(specifier, "." | "..");
        if !folder_only {
            if let Some(found) = self.find(&path) {
                return Some(found);
            }
            let mut candidate = String::with_capacity(path.len() + 8);
            for extension in SCRIPT_EXTENSIONS {
                candidate.clear();
                candidate.push_str(&path);
                candidate.push('.');
                candidate.push_str(extension);
                if let Some(found) = self.find(&candidate) {
                    return Some(found);
                }
            }
            if let Some((stem, extension)) = path.rsplit_once('.') {
                let mapped: &[&str] = match extension {
                    "js" => &["ts", "tsx"],
                    "jsx" => &["tsx"],
                    "mjs" => &["mts"],
                    "cjs" => &["cts"],
                    _ => &[],
                };
                if let Some(found) = mapped
                    .iter()
                    .find_map(|target| self.find(&format!("{stem}.{target}")))
                {
                    return Some(found);
                }
            }
        }
        SCRIPT_INDEXES
            .iter()
            .find_map(|name| self.find(&join_relative(&path, name)))
    }

    /// `@import` de estilos: exato, com extensao, parcial `_nome` do Sass e o
    /// `_index` ou `index` da pasta.
    fn style(&self, source: &str, value: &str) -> Option<u32> {
        let path = resolve_from(source, value)?;
        if let Some(found) = self.find(&path) {
            return Some(found);
        }
        let (folder, name) = split_parent(&path);
        STYLE_EXTENSIONS
            .iter()
            .find_map(|extension| {
                self.find(&format!("{path}.{extension}"))
                    .or_else(|| self.find(&join_relative(folder, &format!("_{name}.{extension}"))))
            })
            .or_else(|| {
                STYLE_EXTENSIONS.iter().find_map(|extension| {
                    self.find(&join_relative(&path, &format!("_index.{extension}")))
                        .or_else(|| self.find(&join_relative(&path, &format!("index.{extension}"))))
                })
            })
    }

    /// Import de Python. Relativo parte da pasta do arquivo e sobe um nivel a
    /// cada ponto alem do primeiro. Absoluto tenta o projeto Python mais
    /// proximo e o `src` dele, a raiz, `src` e a propria pasta, e para na
    /// primeira base que achar algo. No `from`, nome que e submodulo liga ao
    /// arquivo dele; os demais ligam ao modulo. Em `from . import x` o modulo
    /// e o pacote, entao so vale o `__init__.py`, nunca um `pasta.py` ao lado.
    fn python(
        &self,
        source: &'a str,
        level: usize,
        module: &str,
        names: &[String],
        out: &mut Vec<u32>,
    ) {
        let folder = parent_of(source);
        let relative: [String; 1];
        let absolute: Rc<[String]>;
        let bases: &[String] = if level > 0 {
            let mut base = folder;
            for _ in 1..level {
                if base.is_empty() {
                    return;
                }
                base = parent_of(base);
            }
            relative = [base.to_string()];
            &relative
        } else {
            absolute = self.python_bases(folder);
            &absolute
        };
        let module_path = module.replace('.', "/");
        for base in bases {
            let path = join_relative(base, &module_path);
            let before = out.len();
            let mut wants_module = names.is_empty();
            for name in names {
                let submodule = (name != "*")
                    .then(|| self.python_module(&join_relative(&path, name)))
                    .flatten();
                match submodule {
                    Some(found) => out.push(found),
                    None => wants_module = true,
                }
            }
            if wants_module {
                let package = if module.is_empty() {
                    self.find(&join_relative(&path, "__init__.py"))
                } else {
                    self.python_module(&path)
                };
                out.extend(package);
            }
            if out.len() > before {
                return;
            }
        }
    }

    /// Bases do import absoluto vistas de uma pasta, montadas uma vez so.
    fn python_bases(&self, folder: &'a str) -> Rc<[String]> {
        if let Some(bases) = self.python_bases.borrow().get(folder) {
            return Rc::clone(bases);
        }
        let mut bases: Vec<String> = Vec::new();
        if let Some(project) = nearest_dir(folder, |dir| self.python_roots.contains(dir)) {
            bases.push(project.to_string());
            bases.push(join_relative(project, "src"));
        }
        for base in [String::new(), "src".to_string(), folder.to_string()] {
            if !bases.contains(&base) {
                bases.push(base);
            }
        }
        let bases: Rc<[String]> = bases.into();
        self.python_bases
            .borrow_mut()
            .insert(folder, Rc::clone(&bases));
        bases
    }

    fn python_module(&self, path: &str) -> Option<u32> {
        (!path.is_empty())
            .then(|| self.find(&format!("{path}.py")))
            .flatten()
            .or_else(|| self.find(&join_relative(path, "__init__.py")))
    }

    /// Pasta dos submodulos de um arquivo Rust. Raiz de crate e `mod.rs`
    /// guardam os filhos ao lado; os demais, numa pasta com o proprio nome.
    fn rust_children(&self, source: &str, inline: &[String]) -> String {
        let (folder, name) = split_parent(source);
        let stem = name.strip_suffix(".rs").unwrap_or(name);
        let mut base = if self.rust_root(folder, name) {
            folder.to_string()
        } else {
            join_relative(folder, stem)
        };
        for module in inline {
            base = join_relative(&base, module);
        }
        base
    }

    /// `main.rs`, `lib.rs`, `mod.rs`, `build.rs` e os alvos que o Cargo acha
    /// sozinho em `src/bin`, `examples`, `tests` e `benches`.
    fn rust_root(&self, folder: &str, name: &str) -> bool {
        if matches!(name, "main.rs" | "lib.rs" | "mod.rs" | "build.rs") {
            return true;
        }
        let (parent, last) = split_parent(folder);
        match last {
            "examples" | "tests" | "benches" => self.crates.contains(parent),
            "bin" => {
                let (crate_dir, src) = split_parent(parent);
                src == "src" && self.crates.contains(crate_dir)
            }
            _ => false,
        }
    }

    fn rust_mod(&self, source: &str, inline: &[String], name: &str) -> Option<u32> {
        let base = join_relative(&self.rust_children(source, inline), name);
        self.find(&format!("{base}.rs"))
            .or_else(|| self.find(&join_relative(&base, "mod.rs")))
    }

    /// Pasta dos modulos de `crate::` para um arquivo. Na biblioteca e no
    /// binario principal e o `src` do `Cargo.toml` mais proximo. Em `src/bin`,
    /// `examples`, `tests` e `benches` cada alvo e um crate: alvo de um arquivo
    /// so guarda os modulos ao lado dele, e alvo em pasta com `main.rs`, como
    /// `src/bin/tool/main.rs`, dentro da pasta.
    fn crate_modules(&self, source: &str) -> Option<String> {
        let crate_dir = nearest(source, |dir| self.crates.contains(dir))?;
        let inside = match crate_dir {
            "" => source,
            dir => source.strip_prefix(dir)?.strip_prefix('/')?,
        };
        let parts: Vec<&str> = inside.split('/').collect();
        let (kind, rest) = match parts.as_slice() {
            ["src", "bin", rest @ ..] => ("src/bin", rest),
            [kind @ ("examples" | "tests" | "benches"), rest @ ..] => (*kind, rest),
            _ => return Some(join_relative(crate_dir, "src")),
        };
        let single = join_relative(crate_dir, kind);
        if let [folder, _, ..] = rest {
            let own = join_relative(&single, folder);
            if self.find(&join_relative(&own, "main.rs")).is_some() {
                return Some(own);
            }
        }
        Some(single)
    }

    /// `use`: `crate` parte da pasta dos modulos do crate do arquivo, `self` e
    /// `super` do modulo atual, e nome solto tenta um submodulo do atual. O
    /// prefixo mais longo que existir ganha: `a/b.rs`, `a/b/mod.rs`, `a.rs`,
    /// `a/mod.rs`.
    fn rust_use(&self, source: &str, inline: &[String], path: &[String]) -> Option<u32> {
        let first = path.first()?;
        let (base, rest) = match first.as_str() {
            "crate" => (self.crate_modules(source)?, &path[1..]),
            "self" => (self.rust_children(source, inline), &path[1..]),
            "super" => {
                let mut base = self.rust_children(source, inline);
                let mut used = 0;
                for _ in path.iter().take_while(|segment| *segment == "super") {
                    if base.is_empty() {
                        return None;
                    }
                    base = parent_of(&base).to_string();
                    used += 1;
                }
                (base, &path[used..])
            }
            _ => (self.rust_children(source, inline), path),
        };
        if rest.is_empty() {
            return self.rust_module_file(&base);
        }
        (1..=rest.len()).rev().find_map(|length| {
            let joined = join_relative(&base, &rest[..length].join("/"));
            self.find(&format!("{joined}.rs"))
                .or_else(|| self.find(&join_relative(&joined, "mod.rs")))
        })
    }

    /// Arquivo de um modulo, pela pasta dos filhos dele.
    fn rust_module_file(&self, folder: &str) -> Option<u32> {
        (!folder.is_empty())
            .then(|| self.find(&format!("{folder}.rs")))
            .flatten()
            .or_else(|| {
                ["mod.rs", "lib.rs", "main.rs"]
                    .iter()
                    .find_map(|name| self.find(&join_relative(folder, name)))
            })
    }

    /// Import de Go: o `go.mod` mais proximo da origem diz o prefixo do
    /// modulo; se o import nao for dele, vale o modulo de prefixo mais longo
    /// entre os lidos. O alvo e o arquivo que representa o pacote.
    fn go(&self, source: &str, import: &str) -> Option<u32> {
        let own = nearest(source, |dir| self.go_modules.contains_key(dir)).and_then(|dir| {
            module_rest(import, self.go_modules.get(dir)?).map(|rest| join_relative(dir, rest))
        });
        let package = own.or_else(|| {
            self.go_modules
                .iter()
                .filter_map(|(dir, module)| {
                    module_rest(import, module).map(|rest| (module.len(), *dir, rest))
                })
                .max_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(a.1)))
                .map(|(_, dir, rest)| join_relative(dir, rest))
        })?;
        self.go_packages.get(package.as_str()).copied()
    }
}

/// Ligacoes sem repeticao e sem laco, ate o teto.
struct Edges {
    set: HashSet<(u32, u32)>,
    limit: usize,
    full: bool,
}

impl Edges {
    /// `false` quando o teto barrou uma ligacao nova.
    fn add(&mut self, source: u32, target: u32) -> bool {
        if source == target || self.set.contains(&(source, target)) {
            return true;
        }
        if self.set.len() >= self.limit {
            self.full = true;
            return false;
        }
        self.set.insert((source, target));
        true
    }

    fn into_sorted(self) -> Vec<[u32; 2]> {
        let mut links: Vec<[u32; 2]> = self
            .set
            .into_iter()
            .map(|(source, target)| [source, target])
            .collect();
        links.sort_unstable();
        links
    }
}

/* ── ligacoes: cache e leitura ─────────────────────────────────────── */

/// Referencias de um arquivo, validas enquanto tamanho e data baterem.
struct CachedRefs {
    size: u64,
    modified_ms: u64,
    refs: Arc<[Ref]>,
    /// Peso aproximado na memoria, com o caminho que serve de chave.
    weight: usize,
}

impl CachedRefs {
    fn new(relative: &str, size: u64, modified_ms: u64, refs: Arc<[Ref]>) -> Self {
        let weight = relative.len() + 2 * REF_OVERHEAD + weight_of(&refs);
        Self {
            size,
            modified_ms,
            refs,
            weight,
        }
    }
}

/// As referencias guardadas de uma raiz.
#[derive(Default)]
struct RootCache {
    files: HashMap<String, CachedRefs>,
    weight: usize,
    /// Momento do ultimo uso, no relogio do [`CacheStore`].
    used: u64,
}

#[derive(Default)]
struct CacheStore {
    /// Por raiz canonica.
    roots: HashMap<String, RootCache>,
    weight: usize,
    /// Conta cada uso, para saber qual raiz esta parada ha mais tempo.
    clock: u64,
}

/// Referencias cruas por arquivo, guardadas entre varreduras. Vive em
/// [`DocScans`] e serve a todas as sessoes: duas sessoes no mesmo projeto
/// leem cada arquivo uma vez. O peso somado de todas as raizes fica abaixo de
/// [`LINK_CACHE_BUDGET`]: para caber o que chega, saem raizes inteiras, a
/// usada ha mais tempo primeiro. Com a lista completa, o arquivo que saiu
/// dela sai tambem do cache.
pub struct LinkCache {
    store: Mutex<CacheStore>,
    budget: usize,
}

impl Default for LinkCache {
    fn default() -> Self {
        Self {
            store: Mutex::default(),
            budget: LINK_CACHE_BUDGET,
        }
    }
}

impl LinkCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, CacheStore> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Preenche `slots` com o que o cache tem de cada fonte ainda valida e
    /// devolve o peso do que entrou.
    fn fill(
        &self,
        root: &str,
        docs: &[DocEntry],
        sources: &[(usize, Family)],
        slots: &mut [Slot],
    ) -> usize {
        let mut guard = self.lock();
        let store = &mut *guard;
        store.clock += 1;
        let Some(cache) = store.roots.get_mut(root) else {
            return 0;
        };
        cache.used = store.clock;
        let mut held = 0;
        for (slot, (position, _)) in slots.iter_mut().zip(sources) {
            let doc = &docs[*position];
            let valid = cache.files.get(doc.relative.as_str()).filter(|entry| {
                entry.size == doc.size && Some(entry.modified_ms) == doc.modified_ms
            });
            if let Some(entry) = valid {
                held += entry.weight;
                *slot = Some(Arc::clone(&entry.refs));
            }
        }
        held
    }

    /// Guarda o que a varredura leu. `listed`, presente so quando a lista de
    /// arquivos saiu completa, diz se um caminho guardado continua valendo; o
    /// que nao vale sai. Para caber no orcamento, saem antes as outras raizes,
    /// da usada ha mais tempo para a mais recente; o que nem assim cabe fica
    /// de fora.
    fn store(
        &self,
        root: &str,
        listed: Option<&dyn Fn(&str) -> bool>,
        fresh: Vec<(String, CachedRefs)>,
    ) {
        if fresh.is_empty() && listed.is_none() {
            return;
        }
        let mut guard = self.lock();
        let store = &mut *guard;
        store.clock += 1;
        if let (Some(listed), Some(cache)) = (listed, store.roots.get_mut(root)) {
            let mut removed = 0;
            cache.files.retain(|relative, entry| {
                let keep = listed(relative);
                if !keep {
                    removed += entry.weight;
                }
                keep
            });
            cache.weight -= removed;
            store.weight -= removed;
        }
        let incoming: usize = fresh.iter().map(|(_, entry)| entry.weight).sum();
        while store.weight + incoming > self.budget {
            let oldest = store
                .roots
                .iter()
                .filter(|(key, _)| key.as_str() != root)
                .min_by_key(|(_, cache)| cache.used)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                break;
            };
            if let Some(evicted) = store.roots.remove(&oldest) {
                store.weight -= evicted.weight;
            }
        }
        let cache = store.roots.entry(root.to_string()).or_default();
        cache.used = store.clock;
        for (relative, entry) in fresh {
            let replaced = cache.files.get(&relative).map_or(0, |old| old.weight);
            if store.weight - replaced + entry.weight > self.budget {
                continue;
            }
            store.weight += entry.weight;
            cache.weight += entry.weight;
            if let Some(old) = cache.files.insert(relative, entry) {
                store.weight -= old.weight;
                cache.weight -= old.weight;
            }
        }
        if cache.files.is_empty() {
            store.roots.remove(root);
        }
    }

    #[cfg(test)]
    fn with_budget(budget: usize) -> Self {
        Self {
            store: Mutex::default(),
            budget,
        }
    }

    /// Peso total e arquivos guardados de `root`.
    #[cfg(test)]
    fn usage(&self, root: &str) -> (usize, usize) {
        let store = self.lock();
        let files = store.roots.get(root).map_or(0, |cache| cache.files.len());
        (store.weight, files)
    }
}

/// O que a leitura de ligacoes precisa da varredura.
struct LinkJob<'a> {
    docs: &'a [DocEntry],
    /// A raiz canonica: a leitura parte dela.
    base: &'a Path,
    /// A raiz canonica em texto, chave do cache.
    root_key: &'a str,
    cache: Option<&'a LinkCache>,
    options: &'a ScanOptions,
    deadline: Option<Instant>,
    cancel: &'a AtomicBool,
    /// Arquivos que so existem na nuvem e nao sao lidos.
    remote: &'a HashSet<String>,
    /// A lista de arquivos saiu completa: o que nao esta nela pode sair do
    /// cache.
    complete: bool,
}

#[derive(Debug, Default)]
struct LinkPass {
    links: Vec<[u32; 2]>,
    partial: bool,
    read: u32,
}

/// Caminho de leitura de um arquivo da lista, parte a parte: no Windows a
/// raiz pode vir com o prefixo `\\?\`, que nao aceita `/`.
fn path_of(base: &Path, relative: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
    }
    path
}

/// Le o comeco de um arquivo comum. Um FIFO, um dispositivo ou um link posto
/// no lugar do arquivo depois da listagem nao e lido nem trava a leitura.
fn read_head(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_regular(path)?
        .take(limit as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Abre sem seguir link no ultimo nome e sem esperar por quem escreva num
/// FIFO.
#[cfg(unix)]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    regular(file)
}

/// Abre o proprio ponto de reparse, sem seguir link nem junction. Os demais
/// pontos de reparse, como a compressao do WOF, a deduplicacao e os arquivos
/// da nuvem ja baixados, so mostram o conteudo abertos do jeito normal; o que
/// voltou a ficar so na nuvem nao e baixado.
#[cfg(windows)]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let meta = file.metadata()?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 || !meta.is_file() {
        return regular(file);
    }
    if online_only(&meta) {
        return Err(not_regular());
    }
    drop(file);
    regular(fs::File::open(path)?)
}

#[cfg(not(any(unix, windows)))]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    regular(fs::File::open(path)?)
}

/// So arquivo comum passa, conferido no proprio handle aberto.
fn regular(file: fs::File) -> std::io::Result<fs::File> {
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(not_regular())
    }
}

fn not_regular() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a regular file")
}

/// Arquivo que so existe na nuvem, como os do OneDrive sob demanda: ler
/// baixaria o arquivo. `metadata` de uma entrada de pasta nao o baixa.
#[cfg(windows)]
fn online_only(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x4_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
    meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

/// Arquivo do iCloud que ainda nao foi baixado.
#[cfg(target_os = "macos")]
fn online_only(meta: &fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(not(any(windows, target_os = "macos")))]
fn online_only(_meta: &fs::Metadata) -> bool {
    false
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// Le as referencias de cada fonte, do cache ou do disco, e resolve contra a
/// lista. O prazo vale para a leitura do disco e, com uma folga de ate
/// [`RESOLVE_GRACE`], para a resolucao; o que veio do cache entra sem gastar
/// prazo de leitura. Se a varredura for cancelada, o que ja foi lido fica no
/// cache.
fn link_pass(job: &LinkJob<'_>) -> FsResult<LinkPass> {
    let mut pass = LinkPass::default();
    let has_go = job.docs.iter().any(|doc| doc.relative.ends_with(".go"));
    let mut sources: Vec<(usize, Family)> = job
        .docs
        .iter()
        .enumerate()
        .filter(|(_, doc)| !doc.symlink && !job.remote.contains(&doc.relative))
        .filter_map(|(position, doc)| Some((position, family_of(&doc.relative)?)))
        .filter(|(_, family)| has_go || *family != Family::GoMod)
        .collect();
    if sources.len() > job.options.link_file_limit {
        sources.truncate(job.options.link_file_limit);
        pass.partial = true;
    }
    let mut slots: Vec<Slot> = vec![None; sources.len()];
    let mut held = job.cache.map_or(0, |cache| {
        cache.fill(job.root_key, job.docs, &sources, &mut slots)
    });
    let now = now_ms();
    let mut fresh: Vec<(String, CachedRefs)> = Vec::new();
    let mut stopped = false;
    for (slot, (position, family)) in slots.iter_mut().zip(&sources) {
        let doc = &job.docs[*position];
        // Arquivo vazio de verdade nao tem o que ler.
        if slot.is_some() || (doc.size == 0 && doc.modified_ms.is_some()) {
            continue;
        }
        if held >= LINK_SCAN_BUDGET
            || job
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            pass.partial = true;
            break;
        }
        // Sem permissao, sumido ou trocado por algo que nao e arquivo comum:
        // fica sem ligacoes, sem marcar nada.
        if let Ok(bytes) = read_head(
            &path_of(job.base, &doc.relative),
            job.options.link_read_limit,
        ) {
            pass.read += 1;
            let refs: Arc<[Ref]> = extract_refs(*family, &String::from_utf8_lossy(&bytes)).into();
            held += weight_of(&refs);
            // Arquivo mudado ha pouco pode mudar de novo sem mudar a data, que
            // em alguns discos so tem segundos: so entra no cache depois de
            // assentar.
            if let Some(modified_ms) = doc
                .modified_ms
                .filter(|modified| now.saturating_sub(*modified) >= RACY_MS)
            {
                fresh.push((
                    doc.relative.clone(),
                    CachedRefs::new(&doc.relative, doc.size, modified_ms, Arc::clone(&refs)),
                ));
            }
            *slot = Some(refs);
        }
        // Conferido depois de cada leitura: o que ja foi lido vai para o
        // cache antes de a varredura desistir.
        if job.cancel.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
    }
    if let Some(cache) = job.cache {
        // No escopo `docs` a lista so tem Markdown: o resto do cache e do
        // escopo `project` e fica.
        let project = job.options.scope == ScanScope::Project;
        let listed = |relative: &str| {
            (!project && !is_markdown(relative))
                || job
                    .docs
                    .binary_search_by(|doc| doc.relative.as_str().cmp(relative))
                    .is_ok()
        };
        let listed: Option<&dyn Fn(&str) -> bool> = job.complete.then_some(&listed);
        cache.store(job.root_key, listed, fresh);
    }
    if stopped {
        return Err(cancelled());
    }

    // A resolucao tem uma folga propria: quando a leitura gastou o prazo
    // todo, o que foi lido ainda vira ligacao.
    let resolve_deadline = job.deadline.map(|deadline| {
        let grace = job.options.link_time_budget.min(RESOLVE_GRACE);
        Instant::now()
            .checked_add(grace)
            .map_or(deadline, |floor| deadline.max(floor))
    });
    let expired = || resolve_deadline.is_some_and(|deadline| Instant::now() >= deadline);
    let resolver = Resolver::new(job.docs, &sources, &slots);
    let mut edges = Edges {
        set: HashSet::new(),
        limit: job.options.link_limit,
        full: false,
    };
    // Arquivo simbolico nao e lido: ele liga ao proprio alvo.
    for (position, doc) in job.docs.iter().enumerate() {
        let Some(target) = doc.target.as_deref().filter(|_| doc.symlink) else {
            continue;
        };
        let target = if cfg!(windows) {
            Cow::Owned(target.replace('\\', "/"))
        } else {
            Cow::Borrowed(target)
        };
        if let Some(found) = resolver.find(&target) {
            if !edges.add(position as u32, found) {
                break;
            }
        }
    }
    // A mesma referencia vista da mesma pasta da os mesmos alvos; em Rust,
    // vista do mesmo arquivo. Cada uma e resolvida uma vez so.
    let mut memo: HashMap<(&str, &Ref), Box<[u32]>> = HashMap::new();
    let mut scratch = Vec::new();
    let mut seen = 0usize;
    'sources: for ((position, _), slot) in sources.iter().zip(&slots) {
        let Some(refs) = slot else {
            continue;
        };
        if job.cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if expired() {
            pass.partial = true;
            break;
        }
        let source = job.docs[*position].relative.as_str();
        let folder = parent_of(source);
        for reference in refs.iter() {
            seen += 1;
            if seen % RESOLVE_POLL_EVERY == 0 {
                if job.cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                if expired() {
                    pass.partial = true;
                    break 'sources;
                }
            }
            let context = match reference {
                Ref::RustMod { .. } | Ref::RustUse { .. } => source,
                _ => folder,
            };
            let key = (context, reference);
            if memo.len() < RESOLVE_MEMO_LIMIT && !memo.contains_key(&key) {
                scratch.clear();
                resolver.resolve(source, reference, &mut scratch);
                memo.insert(key, scratch.as_slice().into());
            }
            let targets: &[u32] = match memo.get(&key) {
                Some(found) => found,
                None => {
                    scratch.clear();
                    resolver.resolve(source, reference, &mut scratch);
                    &scratch
                }
            };
            for &target in targets {
                if !edges.add(*position as u32, target) {
                    break 'sources;
                }
            }
        }
    }
    pass.partial |= edges.full;
    pass.links = edges.into_sorted();
    Ok(pass)
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
    /// Referencias ja lidas, com trava propria: o registro nunca espera a
    /// leitura de arquivos.
    links: Arc<LinkCache>,
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

    /// O cache de ligacoes do registro, comum a todas as chaves.
    pub fn cache(&self) -> &LinkCache {
        &self.scans.links
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

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// Escreve com a data de uma hora atras: o arquivo ja assentou e pode
    /// entrar no cache.
    fn write_old(root: &Path, relative: &str, content: &str) {
        write(root, relative, content);
        fs::File::options()
            .write(true)
            .open(root.join(relative))
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(3_600))
            .unwrap();
    }

    fn run_with(root: &Path, options: &ScanOptions) -> DocScan {
        scan(&root.to_string_lossy(), &AtomicBool::new(false), options).unwrap()
    }

    fn project(root: &Path) -> DocScan {
        run_with(root, &ScanOptions::for_scope(Some("project")))
    }

    /// Ligacoes como pares de caminhos, na ordem do resultado.
    fn edges(result: &DocScan) -> Vec<(&str, &str)> {
        result
            .links
            .iter()
            .map(|[source, target]| {
                (
                    result.docs[*source as usize].relative.as_str(),
                    result.docs[*target as usize].relative.as_str(),
                )
            })
            .collect()
    }

    /// Alvos das ligacoes que saem de `source`, em ordem de caminho.
    fn targets_of<'r>(result: &'r DocScan, source: &str) -> Vec<&'r str> {
        let mut targets: Vec<&str> = edges(result)
            .into_iter()
            .filter(|(origin, _)| *origin == source)
            .map(|(_, target)| target)
            .collect();
        targets.sort_unstable();
        targets
    }

    /// Quatro notas que apontam umas para as outras.
    fn ring(dir: &Path) {
        for index in 0..4 {
            write(
                dir,
                &format!("n{index}.md"),
                "[0](n0.md) [1](n1.md) [2](n2.md) [3](n3.md)\n",
            );
        }
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
        assert_eq!(
            paths(&result),
            vec!["a.md", "b.Md", "c.markdown", "d.mdx", "notas.md/dentro.md"]
        );
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

    /* ── escopos ── */

    #[test]
    fn escopo_docs_continua_igual() {
        let dir = sandbox("escopo-docs");
        touch(&dir, "README.md");
        touch(&dir, "docs/guia.md");
        touch(&dir, "src/app.ts");
        touch(&dir, "Cargo.toml");
        assert_eq!(ScanOptions::default().scope, ScanScope::Docs);
        let result = run(&dir);
        assert_eq!(result.scope, "docs");
        assert_eq!(paths(&result), vec!["README.md", "docs/guia.md"]);
        // So Markdown e lido atras de ligacoes.
        assert_eq!(result.links_read, 2);
        // O teto de arquivos e so do escopo do projeto.
        let options = ScanOptions {
            file_limit: 1,
            ..ScanOptions::default()
        };
        let capped = run_with(&dir, &options);
        assert_eq!(paths(&capped), vec!["README.md", "docs/guia.md"]);
        assert!(!capped.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn escopo_desconhecido_vale_docs() {
        assert_eq!(ScanOptions::for_scope(None).scope, ScanScope::Docs);
        assert_eq!(ScanOptions::for_scope(Some("docs")).scope, ScanScope::Docs);
        assert_eq!(
            ScanOptions::for_scope(Some("galaxia")).scope,
            ScanScope::Docs
        );
        assert_eq!(
            ScanOptions::for_scope(Some("project")).scope,
            ScanScope::Project
        );
        let dir = sandbox("escopo-desconhecido");
        touch(&dir, "a.md");
        touch(&dir, "b.ts");
        let result = run_with(&dir, &ScanOptions::for_scope(Some("galaxia")));
        assert_eq!(result.scope, "docs");
        assert_eq!(paths(&result), vec!["a.md"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn escopo_do_projeto_lista_todos_os_arquivos() {
        let dir = sandbox("escopo-projeto");
        touch(&dir, "README.md");
        touch(&dir, "src/app.ts");
        touch(&dir, "src/util.ts");
        touch(&dir, "assets/logo.png");
        touch(&dir, "Cargo.toml");
        touch(&dir, "node_modules/pacote/index.js");
        touch(&dir, ".git/config");
        let result = project(&dir);
        assert_eq!(result.scope, "project");
        assert_eq!(
            paths(&result),
            vec![
                "Cargo.toml",
                "README.md",
                "assets/logo.png",
                "src/app.ts",
                "src/util.ts",
            ]
        );
        assert_eq!(result.dirs, 3);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn escopo_do_projeto_para_no_teto() {
        let dir = sandbox("escopo-teto");
        for name in ["e.txt", "a.txt", "d.txt", "b.txt", "c.txt"] {
            touch(&dir, name);
        }
        touch(&dir, "sub/f.txt");
        let capped = ScanOptions {
            file_limit: 3,
            ..ScanOptions::for_scope(Some("project"))
        };
        let result = run_with(&dir, &capped);
        // O corte segue a ordem de nome, nao a do disco.
        assert_eq!(paths(&result), vec!["a.txt", "b.txt", "c.txt"]);
        assert_eq!(result.stopped.as_deref(), Some("limit"));
        assert!(result.partial);
        // No teto exato a varredura sai completa.
        let exact = ScanOptions {
            file_limit: 6,
            ..ScanOptions::for_scope(Some("project"))
        };
        let full = run_with(&dir, &exact);
        assert_eq!(full.docs.len(), 6);
        assert!(!full.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    /* ── ligacoes por linguagem ── */

    #[test]
    fn ligacoes_do_markdown() {
        let dir = sandbox("ligacoes-markdown");
        write(
            &dir,
            "README.md",
            concat!(
                "# Projeto\n",
                "Veja o [guia](docs/guia.md \"titulo\") e a [instalacao](<docs/instalação.md#passo>).\n",
                "![logo](./img/logo%20nova.png?v=2)\n",
                "[fora](https://exemplo.com/docs/guia.md) [mail](mailto:a@b.c) [topo](#topo)\n",
                "[[notas]] e [[docs/guia#parte|apelido]] e ![[img/foto.jpg]]\n",
                "```md\n",
                "[cerca](docs/fora.md)\n",
                "```\n",
                "Codigo em linha: `[span](docs/fora.md)`.\n",
                "<img src=\"img/foto.jpg\" alt=\"foto\">\n",
                "[pasta](docs/)\n",
                "[ref]: /docs/referencia.md \"titulo\"\n",
                "[^1]: docs/fora.md\n",
            ),
        );
        write(
            &dir,
            "docs/guia.md",
            "[volta](../README.md) [[Plano]] [[dup]] [[DUP]]\n[[../notas]]\n",
        );
        write(
            &dir,
            "docs/pagina.mdx",
            "import Grafico from '../ui/Grafico.jsx'\n\n# Titulo\n[guia](guia.md)\n",
        );
        for name in [
            "docs/instalação.md",
            "docs/referencia.md",
            "docs/fora.md",
            "docs/README.md",
            "docs/dup.md",
            "outra/dup.md",
            "planos/plano.md",
            "notas.md",
            "img/logo nova.png",
            "img/foto.jpg",
            "ui/Grafico.jsx",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        assert_eq!(
            targets_of(&result, "README.md"),
            vec![
                "docs/README.md",
                "docs/guia.md",
                "docs/instalação.md",
                "docs/referencia.md",
                "img/foto.jpg",
                "img/logo nova.png",
                "notas.md",
            ]
        );
        // Nome solto acha o unico `plano.md`; no empate, ganha a mesma pasta.
        assert_eq!(
            targets_of(&result, "docs/guia.md"),
            vec!["README.md", "docs/dup.md", "notas.md", "planos/plano.md"]
        );
        assert_eq!(
            targets_of(&result, "docs/pagina.mdx"),
            vec!["docs/guia.md", "ui/Grafico.jsx"]
        );
        // Bloco cercado, codigo em linha e nota de rodape nao ligam.
        assert!(
            edges(&result)
                .iter()
                .all(|(_, target)| *target != "docs/fora.md")
        );
        assert!(!result.links_partial);
        // No escopo docs, so o que e Markdown.
        assert_eq!(
            targets_of(&run(&dir), "README.md"),
            vec![
                "docs/README.md",
                "docs/guia.md",
                "docs/instalação.md",
                "docs/referencia.md",
                "notas.md",
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ligacoes_de_js_e_ts() {
        let dir = sandbox("ligacoes-js");
        write(
            &dir,
            "src/main.ts",
            concat!(
                "import { a } from './a';\n",
                "import b from \"./b.js\";\n",
                "export * from './c';\n",
                "import './estilo.css';\n",
                "const d = require('./d');\n",
                "const e = await import('./e.mjs');\n",
                "import React from 'react';\n",
                "// import z from './z';\n",
                "/*\n",
                "import y from './y';\n",
                "*/\n",
                "import dados from './dados.json?raw';\n",
                "import Comp from '../ui/Comp.vue';\n",
                "import config from '/config';\n",
                "import {\n  f,\n  g,\n} from './f';\n",
                "const lista = Array.from('./z');\n",
            ),
        );
        write(
            &dir,
            "ui/Comp.vue",
            "<script setup>\nimport Item from './Item.vue'\n</script>\n",
        );
        for name in [
            "src/a.ts",
            "src/b.ts",
            "src/c/index.ts",
            "src/estilo.css",
            "src/d.js",
            "src/e.mts",
            "src/z.ts",
            "src/y.ts",
            "src/dados.json",
            "src/f.tsx",
            "ui/Item.vue",
            "config.ts",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        assert_eq!(
            targets_of(&result, "src/main.ts"),
            vec![
                "config.ts",
                "src/a.ts",
                "src/b.ts",
                "src/c/index.ts",
                "src/d.js",
                "src/dados.json",
                "src/e.mts",
                "src/estilo.css",
                "src/f.tsx",
                "ui/Comp.vue",
            ]
        );
        assert_eq!(targets_of(&result, "ui/Comp.vue"), vec!["ui/Item.vue"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ligacoes_de_estilos() {
        let dir = sandbox("ligacoes-estilos");
        write(
            &dir,
            "styles/main.scss",
            concat!(
                "@use 'base';\n",
                "@import \"tema\", 'mixins.css';\n",
                "@forward \"../shared/cores\";\n",
                "@use 'sass:math';\n",
                "@import '~pacote/estilo';\n",
                "// @import 'comentado';\n",
                ".x { background: url(\"../img/fundo.png?x=1#y\"); }\n",
                "@import url(reset.css);\n",
                ".y { mask: url(data:image/png;base64,AAAA); }\n",
            ),
        );
        write(&dir, "styles/legado.sass", "@import base\n");
        for name in [
            "styles/_base.scss",
            "styles/tema.scss",
            "styles/mixins.css",
            "styles/comentado.scss",
            "styles/reset.css",
            "shared/_cores.sass",
            "img/fundo.png",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        assert_eq!(
            targets_of(&result, "styles/main.scss"),
            vec![
                "img/fundo.png",
                "shared/_cores.sass",
                "styles/_base.scss",
                "styles/mixins.css",
                "styles/reset.css",
                "styles/tema.scss",
            ]
        );
        assert_eq!(
            targets_of(&result, "styles/legado.sass"),
            vec!["styles/_base.scss"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ligacoes_de_html() {
        let dir = sandbox("ligacoes-html");
        write(
            &dir,
            "site/index.html",
            concat!(
                "<link href=\"estilo.css\" rel=\"stylesheet\">\n",
                "<script SRC='/app.js'></script>\n",
                "<img data-src=\"img/a.png\" src=img/b.png>\n",
                "<a href=\"https://exemplo.com\">fora</a>\n",
                "<a href=\"sobre.html#time\">time</a>\n",
                "<img srcset=\"img/c.png 2x\">\n",
            ),
        );
        for name in [
            "site/estilo.css",
            "site/img/a.png",
            "site/img/b.png",
            "site/img/c.png",
            "site/sobre.html",
            "app.js",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        assert_eq!(
            targets_of(&result, "site/index.html"),
            vec![
                "app.js",
                "site/estilo.css",
                "site/img/a.png",
                "site/img/b.png",
                "site/sobre.html",
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ligacoes_de_python() {
        let dir = sandbox("ligacoes-python");
        write(
            &dir,
            "pkg/mod_a.py",
            concat!(
                "\"\"\"Docstring\n",
                "import pkg.fantasma\n",
                "\"\"\"\n",
                "from . import mod_b\n",
                "from .sub import util\n",
                "from ..raiz import x\n",
                "import pkg.mod_c as c, os\n",
                "from pkg.sub import (\n",
                "    util,\n",
                "    Coisa,  # comentario\n",
                ")\n",
                "from app.core import y\n",
                "import irmao\n",
            ),
        );
        for name in [
            "pkg/__init__.py",
            "pkg/mod_b.py",
            "pkg/mod_c.py",
            "pkg/fantasma.py",
            "pkg/irmao.py",
            "pkg/sub/__init__.py",
            "pkg/sub/util.py",
            "raiz.py",
            "src/app/__init__.py",
            "src/app/core.py",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        // `Coisa` nao e submodulo e liga ao `__init__` do pacote; `app`
        // so existe em `src`; `irmao` e vizinho do arquivo.
        assert_eq!(
            targets_of(&result, "pkg/mod_a.py"),
            vec![
                "pkg/irmao.py",
                "pkg/mod_b.py",
                "pkg/mod_c.py",
                "pkg/sub/__init__.py",
                "pkg/sub/util.py",
                "raiz.py",
                "src/app/core.py",
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ligacoes_de_rust() {
        let dir = sandbox("ligacoes-rust");
        write(
            &dir,
            "crates/motor/Cargo.toml",
            "[package]\nname = \"motor\"\n",
        );
        write(
            &dir,
            "crates/motor/src/lib.rs",
            concat!(
                "//! Motor.\n",
                "mod grafo;\n",
                "pub(crate) mod util;\n",
                "#[cfg(test)] mod testes;\n",
                "use crate::grafo::{No, Aresta};\n",
                "const CHAVE: char = '{';\n",
            ),
        );
        write(
            &dir,
            "crates/motor/src/grafo.rs",
            concat!(
                "mod camadas;\n",
                "use super::util::Ajuda;\n",
                "use crate::util::texto::limpar;\n",
                "// use crate::fantasma;\n",
                "/* use crate::fantasma; */\n",
                "fn chaves() -> &'static str { \"{{\" }\n",
                "#[cfg(test)]\n",
                "mod tests {\n",
                "    use super::*;\n",
                "    use super::camadas::{\n",
                "        Camada,\n",
                "    };\n",
                "}\n",
            ),
        );
        write(&dir, "crates/motor/src/util/mod.rs", "pub mod texto;\n");
        write(
            &dir,
            "crates/motor/src/util/texto.rs",
            "use crate::grafo;\nuse std::fmt;\n",
        );
        write(&dir, "crates/motor/src/bin/ferramenta.rs", "mod apoio;\n");
        for name in [
            "crates/motor/src/grafo/camadas.rs",
            "crates/motor/src/testes.rs",
            "crates/motor/src/fantasma.rs",
            "crates/motor/src/bin/apoio.rs",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        assert_eq!(
            targets_of(&result, "crates/motor/src/lib.rs"),
            vec![
                "crates/motor/src/grafo.rs",
                "crates/motor/src/testes.rs",
                "crates/motor/src/util/mod.rs",
            ]
        );
        // `super` dentro de `mod tests` e o proprio arquivo: sem laco.
        assert_eq!(
            targets_of(&result, "crates/motor/src/grafo.rs"),
            vec![
                "crates/motor/src/grafo/camadas.rs",
                "crates/motor/src/util/mod.rs",
                "crates/motor/src/util/texto.rs",
            ]
        );
        assert_eq!(
            targets_of(&result, "crates/motor/src/util/mod.rs"),
            vec!["crates/motor/src/util/texto.rs"]
        );
        assert_eq!(
            targets_of(&result, "crates/motor/src/util/texto.rs"),
            vec!["crates/motor/src/grafo.rs"]
        );
        // Binario em `src/bin` guarda os modulos ao lado.
        assert_eq!(
            targets_of(&result, "crates/motor/src/bin/ferramenta.rs"),
            vec!["crates/motor/src/bin/apoio.rs"]
        );
        assert!(
            edges(&result)
                .iter()
                .all(|(_, target)| !target.ends_with("fantasma.rs"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn codigo_rust_sem_strings_e_comentarios() {
        let code =
            rust_code("let c = '{'; let s = r#\"}\"#; // {\n/* { /* } */ */ fn f<'a>() {}\n");
        assert_eq!(code.matches('{').count(), 1);
        assert_eq!(code.matches('}').count(), 1);
        assert_eq!(code.lines().count(), 2);
    }

    #[test]
    fn arvore_do_use() {
        let joined = |paths: Vec<Vec<String>>| {
            paths
                .into_iter()
                .map(|path| path.join("::"))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            joined(use_paths(
                "crate::a::{self, b::{c, d as e}, f::*, r#tipo}",
                REFS_PER_FILE
            )),
            vec![
                "crate::a",
                "crate::a::b::c",
                "crate::a::b::d",
                "crate::a::f",
                "crate::a::tipo",
            ]
        );
        assert_eq!(
            joined(use_paths("super::super::x as y", REFS_PER_FILE)),
            vec!["super::super::x"]
        );
        // Comecar por `::` e de outra crate.
        assert!(use_paths("::std::fs", REFS_PER_FILE).is_empty());
    }

    #[test]
    fn ligacoes_de_go() {
        let dir = sandbox("ligacoes-go");
        write(
            &dir,
            "servico/go.mod",
            "module exemplo.com/servico\n\ngo 1.22\n",
        );
        write(
            &dir,
            "servico/main.go",
            concat!(
                "package main\n\n",
                "import (\n",
                "\t\"fmt\"\n",
                "\t\"exemplo.com/servico/internal/pareamento\"\n",
                "\tcli \"exemplo.com/servico/cmd/cli\"\n",
                "\t_ \"exemplo.com/servico/util\"\n",
                "\t// \"exemplo.com/servico/fantasma\"\n",
                ")\n\n",
                "import \"exemplo.com/outro\"\n",
            ),
        );
        write(
            &dir,
            "servico/cmd/cli/run.go",
            "package cli\n\nimport \"exemplo.com/servico/util\"\n",
        );
        for name in [
            "servico/internal/pareamento/estado.go",
            "servico/internal/pareamento/pareamento.go",
            "servico/cmd/cli/doc.go",
            "servico/util/a_test.go",
            "servico/util/b.go",
            "servico/util/c.go",
            "servico/fantasma/f.go",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        // O pacote e o arquivo com o nome da pasta, o `doc.go` ou o primeiro
        // que nao e teste.
        assert_eq!(
            targets_of(&result, "servico/main.go"),
            vec![
                "servico/cmd/cli/doc.go",
                "servico/internal/pareamento/pareamento.go",
                "servico/util/b.go",
            ]
        );
        assert_eq!(
            targets_of(&result, "servico/cmd/cli/run.go"),
            vec!["servico/util/b.go"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn link_simbolico_liga_ao_alvo_sem_ser_lido() {
        let dir = sandbox("ligacao-simbolica");
        write(&dir, "AGENTS.md", "[guia](docs/guia.md)\n");
        touch(&dir, "docs/guia.md");
        symlink("AGENTS.md", dir.join("CLAUDE.md")).unwrap();
        touch(&dir, "src/app.ts");
        symlink("src/app.ts", dir.join("atalho.ts")).unwrap();
        let docs = run(&dir);
        assert_eq!(
            edges(&docs),
            vec![("AGENTS.md", "docs/guia.md"), ("CLAUDE.md", "AGENTS.md")]
        );
        assert_eq!(docs.links_read, 2);
        assert!(!paths(&docs).contains(&"atalho.ts"));
        // No escopo do projeto, link simbolico de qualquer nome entra.
        let whole = project(&dir);
        assert_eq!(targets_of(&whole, "atalho.ts"), vec!["src/app.ts"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /* ── limites, cache e digital ── */

    #[test]
    fn limite_de_leitura_corta_o_arquivo() {
        let dir = sandbox("limite-leitura");
        write(
            &dir,
            "a.md",
            &format!("[b](b.md)\n{}\n[c](c.md)\n", "x".repeat(200)),
        );
        touch(&dir, "b.md");
        touch(&dir, "c.md");
        let options = ScanOptions {
            link_read_limit: 64,
            ..ScanOptions::default()
        };
        let cut = run_with(&dir, &options);
        assert_eq!(targets_of(&cut, "a.md"), vec!["b.md"]);
        // Ler so o comeco e politica, nao interrupcao.
        assert!(!cut.links_partial);
        assert_eq!(targets_of(&run(&dir), "a.md"), vec!["b.md", "c.md"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn linha_enorme_sem_fecho_nao_trava_nem_enche_o_cache() {
        // Sem os tetos, cada ocorrencia sem fecho olharia o resto da linha e
        // guardaria um pedaco dela.
        for (family, unit) in [
            (Family::Markdown, "]("),
            (Family::Markdown, "-src="),
            (Family::Markdown, "[[a"),
            (Family::Style, "url("),
            (Family::Style, "@import "),
            (Family::Script, "from '"),
        ] {
            let text = unit.repeat(LINK_READ_LIMIT / unit.len());
            let started = Instant::now();
            let refs = extract_refs(family, &text);
            assert!(started.elapsed() < Duration::from_secs(10), "{unit}");
            let bytes: usize = refs.iter().map(Ref::weight).sum();
            assert!(refs.len() <= REFS_PER_FILE, "{unit}");
            assert!(bytes <= REF_BYTES_PER_FILE, "{unit}");
        }
        // Sequencias de crases de tamanhos todos diferentes: nenhuma fecha.
        let mut ticks = String::new();
        let mut size = 1;
        while ticks.len() + size < LINK_READ_LIMIT {
            ticks.push_str(&"`".repeat(size));
            ticks.push('a');
            size += 1;
        }
        let started = Instant::now();
        extract_refs(Family::Markdown, &ticks);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn prazo_zero_marca_ligacoes_parciais() {
        let dir = sandbox("prazo-ligacoes");
        write(&dir, "a.md", "[b](b.md)\n");
        touch(&dir, "b.md");
        let options = ScanOptions {
            link_time_budget: Duration::ZERO,
            ..ScanOptions::default()
        };
        let result = run_with(&dir, &options);
        assert_eq!(paths(&result), vec!["a.md", "b.md"]);
        assert!(result.links.is_empty());
        assert!(result.links_partial);
        assert_eq!(result.links_read, 0);
        // A lista de arquivos continua completa.
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn teto_de_ligacoes_marca_parcial() {
        let dir = sandbox("teto-ligacoes");
        ring(&dir);
        let options = ScanOptions {
            link_limit: 3,
            ..ScanOptions::default()
        };
        let result = run_with(&dir, &options);
        assert_eq!(result.links.len(), 3);
        assert!(result.links_partial);
        assert!(!result.partial);
        // Entram as primeiras na ordem de leitura: as de `n0.md`.
        assert!(edges(&result).iter().all(|(source, _)| *source == "n0.md"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn teto_de_arquivos_com_ligacoes() {
        let dir = sandbox("teto-fontes");
        ring(&dir);
        let options = ScanOptions {
            link_file_limit: 2,
            ..ScanOptions::default()
        };
        let result = run_with(&dir, &options);
        assert_eq!(result.links_read, 2);
        assert_eq!(result.links.len(), 6);
        assert!(
            edges(&result)
                .iter()
                .all(|(source, _)| *source == "n0.md" || *source == "n1.md")
        );
        assert!(result.links_partial);
        assert!(!result.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cache_evita_reler_o_que_nao_mudou() {
        let dir = sandbox("cache-ligacoes");
        write_old(&dir, "a.md", "[b](b.md)\n");
        write_old(&dir, "b.md", "[[c]]\n");
        write_old(&dir, "c.md", "x");
        let cache = LinkCache::default();
        let root = dir.to_string_lossy().to_string();
        let flag = AtomicBool::new(false);
        let options = ScanOptions::default();
        let first = scan_cached(&root, &flag, &options, &cache).unwrap();
        assert_eq!(first.links_read, 3);
        assert_eq!(edges(&first), vec![("a.md", "b.md"), ("b.md", "c.md")]);
        let second = scan_cached(&root, &flag, &options, &cache).unwrap();
        assert_eq!(second.links_read, 0);
        assert_eq!(second.links, first.links);
        assert_eq!(second.fingerprint, first.fingerprint);
        // Mudou de tamanho: so ele e relido.
        write_old(&dir, "a.md", "[b](b.md) e [c](c.md)\n");
        let third = scan_cached(&root, &flag, &options, &cache).unwrap();
        assert_eq!(third.links_read, 1);
        assert_eq!(targets_of(&third, "a.md"), vec!["b.md", "c.md"]);
        assert_ne!(third.fingerprint, first.fingerprint);
        // Sem cache, tudo e lido de novo.
        assert_eq!(run(&dir).links_read, 3);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn registro_divide_o_cache() {
        let dir = sandbox("cache-registro");
        write_old(&dir, "a.md", "[b](b.md)\n");
        write_old(&dir, "b.md", "x");
        let scans = DocScans::default();
        let root = dir.to_string_lossy().to_string();
        let first = {
            let guard = scans.begin("sessao-1", "t1");
            scan_cached(&root, guard.flag(), &ScanOptions::default(), guard.cache()).unwrap()
        };
        let guard = scans.begin("sessao-2", "t1");
        let second =
            scan_cached(&root, guard.flag(), &ScanOptions::default(), guard.cache()).unwrap();
        assert_eq!(first.links_read, 2);
        assert_eq!(second.links_read, 0);
        assert_eq!(second.links, first.links);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leitura_respeita_cancelamento_e_arquivo_na_nuvem() {
        let dir = sandbox("leitura-ligacoes");
        write(&dir, "a.md", "[b](b.md)\n");
        touch(&dir, "b.md");
        let listed = run(&dir);
        let options = ScanOptions::default();
        let nothing = HashSet::new();
        let job = |cancel, remote| LinkJob {
            docs: &listed.docs,
            base: &dir,
            root_key: &listed.canonical_root,
            cache: None,
            options: &options,
            deadline: None,
            cancel,
            remote,
            complete: true,
        };
        let stop = AtomicBool::new(true);
        let error = link_pass(&job(&stop, &nothing)).unwrap_err();
        assert_eq!(error.code, "cancelled");
        // Arquivo so na nuvem entra na lista, mas nao e baixado para leitura.
        let remote: HashSet<String> = ["a.md".to_string()].into();
        let go = AtomicBool::new(false);
        let pass = link_pass(&job(&go, &remote)).unwrap();
        assert_eq!(pass.read, 1);
        assert!(pass.links.is_empty());
        assert!(!pass.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn digital_muda_so_com_a_ligacao() {
        let dir = sandbox("digital-ligacao");
        write(&dir, "a.md", "sem ligacao\n");
        touch(&dir, "b.md");
        let first = run(&dir);
        write(&dir, "a.md", "com [b](b.md)\n");
        let linked = run(&dir);
        assert_eq!(paths(&first), paths(&linked));
        assert_ne!(first.fingerprint, linked.fingerprint);
        // Editar sem mexer nas ligacoes nao muda a digital.
        write(&dir, "a.md", "com [b](b.md) e mais texto\n");
        assert_eq!(linked.fingerprint, run(&dir).fingerprint);
        fs::remove_dir_all(&dir).unwrap();
    }

    /* ── tetos de memoria e de custo ── */

    fn many(prefix: &str, count: usize, separator: &str) -> String {
        (0..count)
            .map(|index| format!("{prefix}{index}"))
            .collect::<Vec<_>>()
            .join(separator)
    }

    #[test]
    fn use_tem_teto_antes_de_copiar() {
        let group = format!("crate::a::{{{}}}", many("n", 100, ", "));
        assert_eq!(use_paths(&group, 7).len(), 7);
        assert!(use_paths(&group, 0).is_empty());
        // Tokens demais: a instrucao e ignorada inteira.
        let tokens = format!("crate::{{{}}}", vec!["x"; USE_TOKEN_LIMIT].join(","));
        assert!(use_paths(&tokens, REFS_PER_FILE).is_empty());
        // Caminho fundo demais para no teto de segmentos.
        let deep = vec!["a"; USE_SEGMENT_LIMIT + 1].join("::");
        assert!(use_paths(&deep, REFS_PER_FILE).is_empty());
        // Prefixo longo nao se multiplica pelas folhas do grupo.
        let prefix = vec!["seg"; 60].join("::");
        let wide = format!("{prefix}::{{{}}}", many("f", 1_000, ","));
        let paths = use_paths(&wide, REFS_PER_FILE);
        assert!(!paths.is_empty());
        assert!(paths.len() <= USE_COPY_LIMIT / (60 * REF_OVERHEAD));
        let huge = format!("{}::{{b, c}}", "a".repeat(USE_COPY_LIMIT));
        assert!(use_paths(&huge, REFS_PER_FILE).is_empty());
        // No arquivo, o teto por arquivo vale antes de abrir o grupo.
        let text = format!("use crate::a::{{{}}};\n", many("m", 2_000, ", "));
        let refs = extract_refs(Family::Rust, &text);
        assert!(!refs.is_empty());
        assert!(weight_of(&refs) <= REF_OVERHEAD + REF_BYTES_PER_FILE);
    }

    #[test]
    fn modulos_em_linha_tem_teto() {
        let empty: Arc<[String]> = Vec::new().into();
        let outside = Ref::RustMod {
            inline: empty,
            name: "fora".to_string(),
        };
        // Alem do teto de profundidade, nada dentro vira referencia.
        let depth = INLINE_DEPTH_LIMIT + 1;
        let text = format!(
            "{}mod dentro;\nuse super::x;\n{}mod fora;\n",
            many("mod m", depth, " {\n") + " {\n",
            "}\n".repeat(depth)
        );
        assert_eq!(extract_refs(Family::Rust, &text), vec![outside.clone()]);
        // Nome em linha maior que o teto de caminho, idem.
        let long = "n".repeat(PATH_LIMIT + 1);
        let text = format!("mod {long} {{\n    mod dentro;\n}}\nmod fora;\n");
        assert_eq!(extract_refs(Family::Rust, &text), vec![outside]);
        // As referencias de dentro dividem o mesmo prefixo.
        let text = "mod m {\n    mod a;\n    mod b;\n}\n";
        let refs = extract_refs(Family::Rust, text);
        let [
            Ref::RustMod { inline: first, .. },
            Ref::RustMod { inline: second, .. },
        ] = refs.as_slice()
        else {
            panic!("{refs:?}");
        };
        assert_eq!(first[..], ["m".to_string()]);
        assert!(Arc::ptr_eq(first, second));
    }

    #[test]
    fn peso_conta_cada_alocacao() {
        assert_eq!(Ref::Url("a".into()).weight(), 1 + 2 * REF_OVERHEAD);
        let python = Ref::Python {
            level: 0,
            module: "m".into(),
            names: vec!["a".into(); 3],
        };
        assert_eq!(python.weight(), 4 + 5 * REF_OVERHEAD);
        // Ligacoes curtas demais nao passam do teto so por serem pequenas.
        let refs = extract_refs(Family::Markdown, &"[a](a) ".repeat(10_000));
        assert!(refs.len() * (1 + 2 * REF_OVERHEAD) <= REF_BYTES_PER_FILE);
        assert!(weight_of(&refs) <= REF_OVERHEAD + REF_BYTES_PER_FILE);
        // `from x import` longo guarda ate o teto de nomes, o ultimo `*`.
        let text = format!("from pkg import ({})\n", many("n", 200, ", "));
        let refs = extract_refs(Family::Python, &text);
        let [Ref::Python { names, .. }] = refs.as_slice() else {
            panic!("{refs:?}");
        };
        assert_eq!(names.len(), PYTHON_NAMES_LIMIT);
        assert_eq!(names.last().map(String::as_str), Some("*"));
    }

    /* ── ligacoes erradas ── */

    #[test]
    fn markdown_ignora_codigo_recuado_e_comentario() {
        let text = concat!(
            "texto\n",
            "    [colado](colado.md)\n",
            "\n",
            "    [codigo](codigo.md)\n",
            "\t[tab](tab.md)\n",
            "\n",
            "- item\n",
            "\n",
            "    [continua](lista.md)\n",
            "\n",
            "<!-- [oculto](oculto.md) -->\n",
            "antes <!-- [meio](meio.md) --> [depois](depois.md)\n",
            "<!--\n",
            "[varias](varias.md)\n",
            "--> [fecho](fecho.md)\n",
            "<!--> [vazio](vazio.md)\n",
        );
        let urls: Vec<String> = extract_refs(Family::Markdown, text)
            .into_iter()
            .filter_map(|reference| match reference {
                Ref::Url(url) => Some(url),
                _ => None,
            })
            .collect();
        assert_eq!(
            urls,
            ["colado.md", "lista.md", "depois.md", "fecho.md", "vazio.md"]
        );
        // No HTML, o comentario tambem fica de fora.
        let html =
            "<!-- <a href=\"a.html\"> -->\n<!--\n<img src=\"b.png\">\n-->\n<a href=\"c.html\">\n";
        assert_eq!(
            extract_refs(Family::Html, html),
            vec![Ref::Url("c.html".into())]
        );
    }

    #[test]
    fn import_relativo_vazio_nao_liga_ao_modulo_vizinho() {
        let dir = sandbox("python-pacote");
        write(
            &dir,
            "pkg/uso.py",
            "from . import util\nfrom . import nada\n",
        );
        write(&dir, "solto/uso.py", "from . import nada\n");
        for name in ["pkg.py", "pkg/__init__.py", "pkg/util.py", "solto.py"] {
            touch(&dir, name);
        }
        let result = project(&dir);
        // `nada` nao e submodulo: liga ao pacote, que e o `__init__.py`.
        assert_eq!(
            targets_of(&result, "pkg/uso.py"),
            vec!["pkg/__init__.py", "pkg/util.py"]
        );
        // Pacote sem `__init__.py` fica sem ligacao, nunca no `solto.py`.
        assert!(targets_of(&result, "solto/uso.py").is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crate_de_cada_alvo_do_cargo() {
        let dir = sandbox("rust-alvos");
        touch(&dir, "Cargo.toml");
        write(&dir, "src/lib.rs", "mod util;\nmod a;\n");
        // Mesmo `mod util;` da mesma pasta: a resolucao depende do arquivo.
        write(&dir, "src/a.rs", "mod util;\n");
        write(&dir, "src/bin/tool.rs", "use crate::helper;\n");
        write(&dir, "src/bin/big/main.rs", "use crate::parts::x;\n");
        write(&dir, "examples/demo.rs", "use crate::extra;\n");
        write(&dir, "tests/it.rs", "use crate::common::ajuda;\n");
        for name in [
            "src/util.rs",
            "src/a/util.rs",
            "src/helper.rs",
            "src/bin/helper.rs",
            "src/bin/big/parts.rs",
            "examples/extra.rs",
            "tests/common/mod.rs",
        ] {
            touch(&dir, name);
        }
        let result = project(&dir);
        assert_eq!(
            targets_of(&result, "src/lib.rs"),
            vec!["src/a.rs", "src/util.rs"]
        );
        assert_eq!(targets_of(&result, "src/a.rs"), vec!["src/a/util.rs"]);
        assert_eq!(
            targets_of(&result, "src/bin/tool.rs"),
            vec!["src/bin/helper.rs"]
        );
        assert_eq!(
            targets_of(&result, "src/bin/big/main.rs"),
            vec!["src/bin/big/parts.rs"]
        );
        assert_eq!(
            targets_of(&result, "examples/demo.rs"),
            vec!["examples/extra.rs"]
        );
        assert_eq!(
            targets_of(&result, "tests/it.rs"),
            vec!["tests/common/mod.rs"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /* ── leitura, cache e prazo ── */

    #[cfg(unix)]
    #[test]
    fn leitura_recusa_fifo_e_link() {
        use std::os::unix::ffi::OsStrExt;
        let dir = sandbox("leitura-fifo");
        write(&dir, "alvo.md", "[x](x.md)\n");
        let fifo = dir.join("fila.md");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: `name` termina em NUL e vive ate o fim da chamada.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        symlink(dir.join("alvo.md"), dir.join("link.md")).unwrap();
        // Sem quem escreva, abrir o FIFO travaria: a guarda de tempo pega.
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(read_head(&fifo, 64).is_err());
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
        assert!(read_head(&dir.join("link.md"), 64).is_err());
        assert!(read_head(&dir.join("alvo.md"), 64).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn arquivo_recem_mudado_nao_entra_no_cache() {
        let dir = sandbox("cache-recente");
        write(&dir, "novo.md", "[velho](velho.md)\n");
        write_old(&dir, "velho.md", "[novo](novo.md)\n");
        let cache = LinkCache::default();
        let root = dir.to_string_lossy().to_string();
        let flag = AtomicBool::new(false);
        let options = ScanOptions::default();
        let first = scan_cached(&root, &flag, &options, &cache).unwrap();
        // As duas ligacoes ja valem nesta varredura.
        assert_eq!(
            edges(&first),
            vec![("novo.md", "velho.md"), ("velho.md", "novo.md")]
        );
        // So o arquivo assentado ficou guardado: o recente e relido.
        let second = scan_cached(&root, &flag, &options, &cache).unwrap();
        assert_eq!(second.links_read, 1);
        assert_eq!(second.links, first.links);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancelamento_guarda_o_que_ja_foi_lido() {
        let dir = sandbox("cancelamento-cache");
        write_old(&dir, "a.md", "[b](b.md)\n");
        write_old(&dir, "b.md", "[a](a.md)\n");
        let listed = run(&dir);
        let cache = LinkCache::default();
        let options = ScanOptions::default();
        let nothing = HashSet::new();
        let job = |cancel| LinkJob {
            docs: &listed.docs,
            base: Path::new(&listed.canonical_root),
            root_key: &listed.canonical_root,
            cache: Some(&cache),
            options: &options,
            deadline: None,
            cancel,
            remote: &nothing,
            complete: true,
        };
        let stop = AtomicBool::new(true);
        assert_eq!(link_pass(&job(&stop)).unwrap_err().code, "cancelled");
        let go = AtomicBool::new(false);
        let pass = link_pass(&job(&go)).unwrap();
        assert_eq!(pass.read, 1);
        assert_eq!(pass.links.len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prazo_vale_tambem_para_resolver() {
        let dir = sandbox("prazo-resolver");
        write_old(&dir, "a.md", "[b](b.md)\n");
        write_old(&dir, "b.md", "[a](a.md)\n");
        let cache = LinkCache::default();
        let root = dir.to_string_lossy().to_string();
        let flag = AtomicBool::new(false);
        let warm = scan_cached(&root, &flag, &ScanOptions::default(), &cache).unwrap();
        assert_eq!(warm.links.len(), 2);
        let options = ScanOptions {
            link_time_budget: Duration::ZERO,
            ..ScanOptions::default()
        };
        // Tudo vem do cache, mas sem prazo nada e resolvido.
        let cut = scan_cached(&root, &flag, &options, &cache).unwrap();
        assert_eq!(cut.links_read, 0);
        assert!(cut.links.is_empty());
        assert!(cut.links_partial);
        assert!(!cut.partial);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cache_tem_orcamento_e_sai_a_raiz_mais_parada() {
        let entry = |relative: &str| {
            let refs: Arc<[Ref]> = vec![Ref::Url("x.md".into())].into();
            (relative.to_string(), CachedRefs::new(relative, 1, 1, refs))
        };
        let weight = entry("a.md").1.weight;
        let cache = LinkCache::with_budget(3 * weight);
        cache.store("r1", None, vec![entry("a.md"), entry("b.md")]);
        cache.store("r2", None, vec![entry("a.md")]);
        assert_eq!(cache.usage("r1"), (3 * weight, 2));
        // Usar `r1` faz de `r2` a raiz parada ha mais tempo.
        let docs = vec![DocEntry {
            relative: "a.md".into(),
            size: 1,
            modified_ms: Some(1),
            symlink: false,
            target: None,
        }];
        let mut slots = vec![None];
        let held = cache.fill("r1", &docs, &[(0, Family::Markdown)], &mut slots);
        assert_eq!(held, weight);
        assert!(slots[0].is_some());
        cache.store("r3", None, vec![entry("a.md")]);
        assert_eq!(cache.usage("r2"), (3 * weight, 0));
        assert_eq!(cache.usage("r1").1, 2);
        assert_eq!(cache.usage("r3").1, 1);
        // O que nao cabe nem sozinho fica de fora.
        let refs: Arc<[Ref]> = vec![Ref::Url("y".repeat(3 * weight))].into();
        cache.store(
            "r1",
            None,
            vec![("c.md".into(), CachedRefs::new("c.md", 1, 1, refs))],
        );
        assert!(cache.usage("r1").0 <= 3 * weight);
        assert_eq!(cache.usage("r1").1, 2);
        // Com a lista completa, o que saiu dela sai do cache.
        let listed = |relative: &str| relative == "a.md";
        cache.store("r1", Some(&listed), Vec::new());
        assert_eq!(cache.usage("r1").1, 1);
    }

    #[test]
    fn cache_esquece_o_apagado_e_guarda_o_outro_escopo() {
        let dir = sandbox("cache-poda");
        write_old(&dir, "a.md", "[b](b.md)\n");
        write_old(&dir, "b.md", "x\n");
        write_old(&dir, "app.ts", "import './a.md';\n");
        let cache = LinkCache::default();
        let root = dir.to_string_lossy().to_string();
        let flag = AtomicBool::new(false);
        let whole = scan_cached(
            &root,
            &flag,
            &ScanOptions::for_scope(Some("project")),
            &cache,
        )
        .unwrap();
        let key = whole.canonical_root.as_str();
        assert_eq!(cache.usage(key).1, 3);
        // A lista do escopo `docs` so tem Markdown: o `.ts` continua.
        let docs = scan_cached(&root, &flag, &ScanOptions::default(), &cache).unwrap();
        assert_eq!(docs.links_read, 0);
        assert_eq!(cache.usage(key).1, 3);
        fs::remove_file(dir.join("b.md")).unwrap();
        scan_cached(&root, &flag, &ScanOptions::default(), &cache).unwrap();
        assert_eq!(cache.usage(key).1, 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Medida num projeto de verdade: `CIALAI_DOCGRAPH_BENCH_ROOT=/caminho cargo
    /// test docgraph_bench -- --ignored --nocapture`. Cada escopo tem o proprio
    /// cache: a primeira rodada le do disco e as seguintes, do cache.
    #[test]
    #[ignore]
    fn docgraph_bench() {
        let Ok(root) = std::env::var("CIALAI_DOCGRAPH_BENCH_ROOT") else {
            return;
        };
        for scope in [ScanScope::Docs, ScanScope::Project] {
            let options = ScanOptions::for_scope(Some(scope.as_str()));
            let cache = LinkCache::default();
            for round in 0..3 {
                let result = scan_cached(&root, &AtomicBool::new(false), &options, &cache).unwrap();
                println!(
                    "{} rodada {round}: {} docs, {} pastas, {} entradas, {} ligacoes, {} lidos, {} ms, parcial {}, parou {:?}, excluido {:?}",
                    scope.as_str(),
                    result.docs.len(),
                    result.dirs,
                    result.visited,
                    result.links.len(),
                    result.links_read,
                    result.elapsed_ms,
                    result.partial,
                    result.stopped,
                    result.excluded
                );
            }
        }
    }
}
