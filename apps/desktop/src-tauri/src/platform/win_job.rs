// SPDX-License-Identifier: Apache-2.0
//! Job Object por sessao ConPTY. Fechar o ultimo handle recolhe a arvore.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

const MEMBER_CAPACITY: usize = 1024;

fn registry() -> &'static Mutex<HashMap<u32, Weak<JobInner>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u32, Weak<JobInner>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct JobInner {
    handle: usize,
}

impl JobInner {
    fn raw(&self) -> HANDLE {
        self.handle as HANDLE
    }
}

impl Drop for JobInner {
    fn drop(&mut self) {
        // SAFETY: `handle` foi criado por CreateJobObjectW e tem um unico dono.
        unsafe {
            CloseHandle(self.raw());
        }
    }
}

#[derive(Clone)]
pub(crate) struct JobHandle {
    inner: Arc<JobInner>,
}

impl JobHandle {
    #[allow(dead_code)]
    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: o handle permanece valido enquanto `self` vive.
        let ok = unsafe { TerminateJobObject(self.inner.raw(), 1) };
        bool_result(ok)
    }
}

/// Cria um job privado, ativa `KILL_ON_JOB_CLOSE` e atribui o shell.
pub(crate) fn assign(shell_pid: u32) -> io::Result<JobHandle> {
    // SAFETY: atributos e nome nulos criam um Job Object anonimo.
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let result = configure_and_assign(handle, shell_pid);
    if let Err(error) = result {
        // SAFETY: falha antes de transferir o handle ao Arc.
        unsafe {
            CloseHandle(handle);
        }
        return Err(error);
    }
    let inner = Arc::new(JobInner {
        handle: handle as usize,
    });
    lock(registry()).insert(shell_pid, Arc::downgrade(&inner));
    Ok(JobHandle { inner })
}

fn configure_and_assign(job: HANDLE, shell_pid: u32) -> io::Result<()> {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: a classe corresponde ao layout e tamanho de `limits`.
    let ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        )
    };
    bool_result(ok)?;

    // SAFETY: direitos minimos para atribuir e encerrar o processo pelo job.
    let process = unsafe {
        OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            shell_pid,
        )
    };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: ambos os handles sao validos durante a chamada.
    let assigned = unsafe { AssignProcessToJobObject(job, process) };
    // SAFETY: o handle de processo nao e guardado.
    unsafe {
        CloseHandle(process);
    }
    bool_result(assigned)
}

pub(crate) fn members_for(shell_pid: u32) -> Vec<u32> {
    let inner = {
        let mut jobs = lock(registry());
        let Some(inner) = jobs.get(&shell_pid).and_then(Weak::upgrade) else {
            jobs.remove(&shell_pid);
            return Vec::new();
        };
        inner
    };
    query_members(inner.raw()).unwrap_or_default()
}

fn query_members(job: HANDLE) -> io::Result<Vec<u32>> {
    let bytes = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
        + (MEMBER_CAPACITY - 1) * std::mem::size_of::<usize>();
    let mut buffer = vec![0u8; bytes];
    // SAFETY: o buffer tem espaco para o cabecalho e MEMBER_CAPACITY ids.
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr() as *mut c_void,
            buffer.len() as u32,
            std::ptr::null_mut(),
        )
    };
    bool_result(ok)?;
    // SAFETY: a consulta bem sucedida inicializou o cabecalho e a lista.
    let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
    let count = (list.NumberOfProcessIdsInList as usize).min(MEMBER_CAPACITY);
    let ids = list.ProcessIdList.as_ptr();
    // SAFETY: o buffer foi dimensionado para `count` entradas.
    let mut members = unsafe { std::slice::from_raw_parts(ids, count) }
        .iter()
        .filter_map(|pid| u32::try_from(*pid).ok())
        .filter(|pid| *pid != 0)
        .collect::<Vec<_>>();
    members.sort_unstable();
    members.dedup();
    Ok(members)
}

fn bool_result(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
