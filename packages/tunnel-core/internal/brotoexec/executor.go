// Package brotoexec executes authenticated host requests under a local capability ceiling.
package brotoexec

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Config struct {
	// Test seam; not configurable by the remote peer.
	transferIdleTimeout time.Duration
	AllowFiles          bool
	MaxFileMB           int64
	OnExecOutput        func(uint64, string, []byte)
	AllowExec           bool
	AllowPTY            bool
	Dir                 string
	Shell               string
	MaxDuration         time.Duration
	MaxOutput           int
	OnOutput            func(uint32, []byte)
	AllocateID          func() (uint32, error)
}
type AuditEntry struct {
	Time    time.Time `json:"time"`
	Verb    string    `json:"verb"`
	Outcome string    `json:"outcome"`
}
type Executor struct {
	mu             sync.Mutex
	config         Config
	paused, closed bool
	next           uint32
	sessions       map[uint32]*session
	running        map[uint64]context.CancelFunc
	seq            uint64
	downloads      map[string]*download
	uploads        map[string]*upload
	audit          []AuditEntry
}
type session struct {
	mu       sync.Mutex
	terminal terminal
	data     []byte
	offset   uint64
	done     bool
	exit     int
	dir      string
}
type terminal interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(int, int) error
	Kill() error
	Wait() (int, error)
	Close() error
}
type Args struct {
	Stream    bool              `json:"stream"`
	CallID    uint64            `json:"call_id"`
	Version   int               `json:"version"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	Dir       string            `json:"dir"`
	Env       map[string]string `json:"env"`
	TimeoutMS int64             `json:"timeout_ms"`
	Shell     string            `json:"shell"`
	Cols      int               `json:"cols"`
	Rows      int               `json:"rows"`
	ID        uint32            `json:"id"`
	Data      []byte            `json:"data"`
	Offset    uint64            `json:"offset"`
}

// New prepares the process token before any command can start. The Broto has
// the rights of the account it runs under, administrator and root included.
func New(c Config) *Executor {
	prepareAccount()
	if c.transferIdleTimeout <= 0 {
		c.transferIdleTimeout = 15 * time.Minute
	}
	if c.MaxDuration <= 0 {
		c.MaxDuration = 30 * time.Minute
	}
	if c.MaxOutput <= 0 || c.MaxOutput > 4<<20 {
		c.MaxOutput = 256 << 10
	}
	if c.MaxFileMB <= 0 {
		c.MaxFileMB = 512
	}
	return &Executor{downloads: map[string]*download{}, uploads: map[string]*upload{}, config: c, sessions: map[uint32]*session{}, running: map[uint64]context.CancelFunc{}}
}
func (e *Executor) record(verb, outcome string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.audit = append(e.audit, AuditEntry{time.Now().UTC(), verb, outcome})
	if len(e.audit) > 256 {
		e.audit = append([]AuditEntry(nil), e.audit[len(e.audit)-256:]...)
	}
}
func (e *Executor) Audit() []AuditEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]AuditEntry(nil), e.audit...)
}
func (e *Executor) SetPaused(v bool) {
	e.mu.Lock()
	e.paused = v
	if v {
		e.cancelUploads()
	}
	e.mu.Unlock()
}
func (e *Executor) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closed = true
	e.cancelUploads()
	e.stopLocked()
	return nil
}
func (e *Executor) stopLocked() {
	for _, cancel := range e.running {
		cancel()
	}
	for _, s := range e.sessions {
		s.mu.Lock()
		if !s.done {
			_ = s.terminal.Kill()
		}
		s.mu.Unlock()
	}
}
func (e *Executor) Handle(ctx context.Context, verb string, raw json.RawMessage) (result any, err error) {
	return e.HandleCall(ctx, 0, verb, raw)
}
func (e *Executor) HandleCall(ctx context.Context, callID uint64, verb string, raw json.RawMessage) (result any, err error) {
	// Audit deliberately excludes command arguments, environment and output.
	defer func() {
		outcome := "ok"
		if err != nil {
			outcome = "error"
		}
		e.record(verbSafe(verb), outcome)
	}()
	var a Args
	if len(raw) > 0 {
		if len(raw) > 2<<20 {
			return nil, errors.New("request too large")
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return nil, errors.New("invalid arguments")
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil, failure("executor_closed", "O Broto está desconectado.")
	}
	if e.paused && verb != "hello" && verb != "pty.list" && verb != "pty.read" && verb != "exec.cancel" && verb != "files.cancel" && verb != "files.list" && verb != "files.stat" {
		return nil, failure("executor_paused", "O Broto está pausado nesta máquina.")
	}
	if strings.HasPrefix(verb, "files.") {
		return e.files(verb, raw)
	}
	switch verb {
	case "hello":
		if a.Version != 0 && a.Version != 1 {
			return nil, errors.New("unsupported protocol version")
		}
		return map[string]any{"version": 1, "exec": e.config.AllowExec, "pty": e.config.AllowPTY, "shell": e.ExecShell(), "files": e.config.AllowFiles}, nil
	}
	switch verb {
	case "exec.cancel":
		if cancel := e.running[a.CallID]; cancel != nil {
			cancel()
		}
		return map[string]bool{"ok": true}, nil
	case "exec":
		if !e.config.AllowExec {
			return nil, failure("exec_disabled_locally", "A política local desta máquina desabilitou exec.")
		}
		if a.Command == "" {
			return nil, errors.New("command required")
		}
		if err = checkDirectory(e.dir(a.Dir)); err != nil {
			return nil, err
		}
		duration := 5 * time.Minute
		if duration > e.config.MaxDuration {
			duration = e.config.MaxDuration
		}
		if a.TimeoutMS > 0 {
			if a.TimeoutMS > int64(e.config.MaxDuration/time.Millisecond) {
				return nil, errors.New("duration exceeds local policy")
			}
			duration = time.Duration(a.TimeoutMS) * time.Millisecond
		}
		runctx, cancel := context.WithTimeout(ctx, duration)
		e.seq++
		id := callID
		if id == 0 {
			id = e.seq
		}
		e.running[id] = cancel
		cmd := exec.CommandContext(runctx, a.Command, a.Args...)
		prepareCommand(cmd)
		cmd.Dir = e.dir(a.Dir)
		cmd.Env = environment(a.Env)
		cmd.WaitDelay = time.Second
		stdout, stderr := &bounded{limit: e.config.MaxOutput}, &bounded{limit: e.config.MaxOutput}
		cmd.Stdout = stdout
		cmd.Stderr = stderr
		if a.Stream && e.config.OnExecOutput != nil {
			cmd.Stdout = io.MultiWriter(stdout, streamWriter{func(p []byte) { e.config.OnExecOutput(id, "stdout", p) }})
			cmd.Stderr = io.MultiWriter(stderr, streamWriter{func(p []byte) { e.config.OnExecOutput(id, "stderr", p) }})
		}
		e.mu.Unlock()
		runErr := runCommand(runctx, cmd)
		e.mu.Lock()
		delete(e.running, id)
		cancel()
		code := 0
		if runErr != nil {
			var exit *exec.ExitError
			if errors.As(runErr, &exit) {
				code = exit.ExitCode()
			} else {
				return nil, startFailure(runErr)
			}
		}
		return map[string]any{"stdout": stdout.String(), "stderr": stderr.String(), "exit_code": code, "timed_out": errors.Is(runctx.Err(), context.DeadlineExceeded), "truncated": stdout.truncated || stderr.truncated}, nil
	case "pty.open":
		if !e.config.AllowPTY {
			return nil, failure("pty_disabled_locally", "A política local desta máquina desabilitou PTY.")
		}
		if len(e.sessions) >= 32 {
			for id, existing := range e.sessions {
				existing.mu.Lock()
				done := existing.done
				existing.mu.Unlock()
				if done {
					delete(e.sessions, id)
					break
				}
			}
		}
		if len(e.sessions) >= 32 {
			return nil, errors.New("session limit reached")
		}
		shell := a.Shell
		if shell == "" {
			shell = e.config.Shell
		}
		cols, rows := a.Cols, a.Rows
		if cols == 0 {
			cols = 80
		}
		if rows == 0 {
			rows = 24
		}
		if cols < 1 || rows < 1 || cols > 1000 || rows > 1000 {
			return nil, errors.New("invalid terminal size")
		}
		var id uint32
		if e.config.AllocateID != nil {
			var allocErr error
			id, allocErr = e.config.AllocateID()
			if allocErr != nil {
				return nil, allocErr
			}
			if id == 0 {
				return nil, errors.New("invalid session id")
			}
		} else {
			if e.next == ^uint32(0) {
				return nil, errors.New("session id exhausted")
			}
			e.next++
			id = e.next
		}
		if err = checkDirectory(e.dir(a.Dir)); err != nil {
			return nil, err
		}
		t, startErr := startTerminal(shell, e.dir(a.Dir), cols, rows)
		if startErr != nil {
			return nil, startFailure(startErr)
		}
		s := &session{terminal: t, dir: e.dir(a.Dir)}
		e.sessions[id] = s
		go e.read(id, s)
		return map[string]any{"id": id}, nil
	case "pty.list":
		items := []map[string]any{}
		for id, s := range e.sessions {
			s.mu.Lock()
			items = append(items, map[string]any{"id": id, "dir": s.dir, "exited": s.done, "exit_code": s.exit})
			s.mu.Unlock()
		}
		return items, nil
	case "pty.write", "pty.resize", "pty.kill", "pty.read":
		s := e.sessions[a.ID]
		if s == nil {
			return nil, errors.New("unknown session")
		}
		switch verb {
		case "pty.write":
			e.mu.Unlock()
			_, err = s.terminal.Write(a.Data)
			e.mu.Lock()
		case "pty.resize":
			if a.Cols < 1 || a.Rows < 1 || a.Cols > 1000 || a.Rows > 1000 {
				return nil, errors.New("invalid terminal size")
			}
			err = s.terminal.Resize(a.Cols, a.Rows)
		case "pty.kill":
			s.mu.Lock()
			if !s.done {
				err = s.terminal.Kill()
			}
			s.mu.Unlock()
		case "pty.read":
			s.mu.Lock()
			defer s.mu.Unlock()
			start := a.Offset
			if start < s.offset {
				start = s.offset
			}
			end := s.offset + uint64(len(s.data))
			if start > end {
				start = end
			}
			readEnd := end
			if readEnd-start > 64<<10 {
				readEnd = start + 64<<10
			}
			return map[string]any{"data": append([]byte(nil), s.data[start-s.offset:readEnd-s.offset]...), "offset": start, "next_offset": readEnd, "total_offset": end, "exited": s.done, "exit_code": s.exit}, nil
		}
		return map[string]bool{"ok": err == nil}, err
	default:
		return nil, errors.New("unsupported command")
	}
}
func (e *Executor) dir(dir string) string {
	if dir != "" {
		return dir
	}
	return e.config.Dir
}
func (e *Executor) read(id uint32, s *session) {
	buf := make([]byte, 16384)
	for {
		n, err := s.terminal.Read(buf)
		if n > 0 {
			p := append([]byte(nil), buf[:n]...)
			s.mu.Lock()
			s.data = append(s.data, p...)
			if len(s.data) > e.config.MaxOutput {
				trim := len(s.data) - e.config.MaxOutput
				s.offset += uint64(trim)
				s.data = append([]byte(nil), s.data[trim:]...)
			}
			s.mu.Unlock()
			if e.config.OnOutput != nil {
				e.config.OnOutput(id, p)
			}
		}
		if err != nil {
			break
		}
	}
	code, _ := s.terminal.Wait()
	_ = s.terminal.Close()
	s.mu.Lock()
	s.done = true
	s.exit = code
	s.mu.Unlock()
}
func environment(extra map[string]string) []string {
	env := os.Environ()
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
func verbSafe(v string) string {
	switch v {
	case "files.list", "files.stat", "files.get", "files.put", "files.cancel", "exec.cancel", "hello", "exec", "pty.open", "pty.list", "pty.read", "pty.write", "pty.resize", "pty.kill":
		return v
	}
	return "unknown"
}

type bounded struct {
	data      []byte
	limit     int
	truncated bool
}

func (b *bounded) Write(p []byte) (int, error) {
	n := len(p)
	room := b.limit - len(b.data)
	if len(p) > room {
		p = p[:room]
		b.truncated = true
	}
	b.data = append(b.data, p...)
	return n, nil
}
func (b *bounded) String() string {
	data := b.data
	if b.truncated {
		start := len(data) - 1
		for start >= 0 && len(data)-start <= utf8.UTFMax && !utf8.RuneStart(data[start]) {
			start--
		}
		if start >= 0 && !utf8.FullRune(data[start:]) {
			data = data[:start]
		}
	}
	return string(data)
}

// ExecShell is the shell used for noninteractive automation.
func (e *Executor) ExecShell() string {
	if runtime.GOOS == "windows" {
		return "powershell.exe"
	}
	if e.config.Shell != "" {
		return e.config.Shell
	}
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}

type streamWriter struct{ emit func([]byte) }

func (w streamWriter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		size := len(p)
		if size > 64<<10 {
			size = 64 << 10
		}
		w.emit(append([]byte(nil), p[:size]...))
		p = p[size:]
	}
	return n, nil
}
