package brotoexec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type fileArgs struct {
	Path        string `json:"path"`
	Offset      int64  `json:"offset"`
	Length      int    `json:"length"`
	Data        []byte `json:"data"`
	Final       bool   `json:"final"`
	SHA256      string `json:"sha256"`
	ChunkSHA256 string `json:"chunk_sha256"`
	Overwrite   bool   `json:"overwrite"`
	Size        int64  `json:"size"`
	TransferID  string `json:"transfer_id"`
}
type download struct {
	file    *os.File
	info    os.FileInfo
	hash    hash.Hash
	offset  int64
	updated time.Time
}
type upload struct {
	unlock     func()
	updated    time.Time
	expiry     *time.Timer
	info       os.FileInfo
	root       *os.Root
	file       *os.File
	name       string
	size       int64
	expected   int64
	hash       hash.Hash
	overwrite  bool
	transferID string
}

func (e *Executor) cancelUploads() {
	for key, d := range e.downloads {
		d.file.Close()
		delete(e.downloads, key)
	}
	for path, u := range e.uploads {
		e.releaseUpload(path, u, true)
	}
}
func (e *Executor) fileRoot(path string) (*os.Root, string, error) {
	if path == "" {
		path = "."
	}
	if !filepath.IsAbs(path) {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, "", err
		}
		path = filepath.Join(home, path)
	}
	path = filepath.Clean(path)
	// Reject Windows special names on all hosts, including ADS syntax.
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
			return nil, "", failure("file_invalid_name", "O nome do arquivo é reservado pelo sistema.")
		}
		if strings.Contains(part, ":") && part != filepath.VolumeName(path) {
			return nil, "", failure("file_invalid_name", "Fluxos alternativos de arquivos não são permitidos.")
		}
	}
	// Resolve the requested destination with the account's filesystem access.
	// A new upload may have a missing leaf, but its parent must already exist.
	resolved, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) {
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(path))
		if parentErr != nil {
			return nil, "", parentErr
		}
		resolved = filepath.Join(parent, filepath.Base(path))
	} else if err != nil {
		return nil, "", err
	}
	parent, name := filepath.Dir(resolved), filepath.Base(resolved)
	if parent == resolved {
		name = "."
	}
	// Hold the actual parent directory while transferring. This keeps staging,
	// locking and publication together even if a parent link is later changed.
	root, err := os.OpenRoot(parent)
	return root, name, err
}
func fileInfo(info os.FileInfo) map[string]any {
	kind := "file"
	if info.Mode()&os.ModeSymlink != 0 {
		kind = "symlink"
	} else if !info.Mode().IsRegular() && !info.IsDir() {
		kind = "other"
	}
	if info.IsDir() {
		kind = "directory"
	}
	return map[string]any{"name": info.Name(), "type": kind, "size": info.Size(), "modified": info.ModTime().UTC()}
}
func (e *Executor) files(verb string, raw json.RawMessage) (result any, err error) {
	defer func() {
		if err != nil {
			err = fileFailure(err)
		}
	}()
	if !e.config.AllowFiles {
		return nil, failure("files_disabled_locally", "A política local desabilitou o acesso a arquivos.")
	}
	var a fileArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.Offset < 0 || a.Size < 0 {
		return nil, failure("file_invalid_range", "O tamanho ou a posição do arquivo é inválido.")
	}
	root, name, err := e.fileRoot(a.Path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	limit := e.config.MaxFileMB * 1024 * 1024
	for key, d := range e.downloads {
		if time.Since(d.updated) > 15*time.Minute {
			d.file.Close()
			delete(e.downloads, key)
		}
	}
	key := filepath.Join(root.Name(), name)
	switch verb {
	case "files.get":
		return e.getFile(root, name, key, a, limit)
	case "files.cancel":
		if d := e.downloads[key+"\x00"+a.TransferID]; d != nil {
			d.file.Close()
			delete(e.downloads, key+"\x00"+a.TransferID)
		}
		if u := e.uploads[key]; u != nil {
			if u.transferID != a.TransferID {
				return nil, failure("file_transfer_mismatch", "O bloco não corresponde à transferência em andamento.")
			}
			e.releaseUpload(key, u, true)
		}
		return map[string]bool{"ok": err == nil}, err
	case "files.list", "files.stat":
		f, err := root.Open(name)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return nil, err
		}
		if verb == "files.list" {
			if !info.IsDir() {
				return nil, failure("file_not_directory", "O caminho não é uma pasta.")
			}
			entries, err := f.ReadDir(4097)
			if len(entries) > 4096 {
				return nil, failure("file_directory_limit", "A pasta ultrapassa o limite de entradas.")
			}
			if err == io.EOF {
				err = nil
			}
			if err != nil {
				return nil, err
			}
			out := []map[string]any{}
			for _, entry := range entries {
				i, err := entry.Info()
				if err == nil {
					out = append(out, fileInfo(i))
				}
			}
			return out, nil
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return nil, failure("file_not_regular", "O caminho não é um arquivo comum.")
		}
		if info.Size() > limit {
			return nil, failure("file_size_limit", "O arquivo ultrapassa o limite da política local.")
		}
		if verb == "files.stat" {
			out := fileInfo(info)
			if info.Mode().IsRegular() {
				h := sha256.New()
				if _, err = io.Copy(h, io.LimitReader(f, limit+1)); err != nil {
					return nil, err
				}
				out["sha256"] = hex.EncodeToString(h.Sum(nil))
			}
			return out, nil
		}
		if !info.Mode().IsRegular() {
			return nil, failure("file_not_regular", "O caminho não é um arquivo comum.")
		}
		if a.Length <= 0 || a.Length > 1<<20 {
			return nil, failure("file_invalid_range", "O tamanho do bloco é inválido.")
		}
		if a.Offset > info.Size() {
			return nil, failure("file_invalid_range", "A posição ultrapassa o tamanho do arquivo.")
		}
		data := make([]byte, a.Length)
		n, err := f.ReadAt(data, a.Offset)
		if err != nil && err != io.EOF {
			return nil, err
		}
		data = data[:n]
		hash := sha256.Sum256(data)
		return map[string]any{"data": data, "eof": a.Offset+int64(n) >= info.Size(), "next_offset": a.Offset + int64(n), "chunk_sha256": hex.EncodeToString(hash[:]), "size": info.Size()}, nil
	case "files.put":
		if len(a.Data) > 1<<20 || a.Offset > limit-int64(len(a.Data)) || a.Size > limit {
			return nil, failure("file_size_limit", "O arquivo ultrapassa o limite da política local.")
		}
		if a.ChunkSHA256 != "" {
			hash := sha256.Sum256(a.Data)
			if hex.EncodeToString(hash[:]) != a.ChunkSHA256 {
				return nil, failure("file_hash_mismatch", "O hash do bloco não corresponde aos bytes recebidos.")
			}
		}
		u := e.uploads[key]
		if u == nil {
			if a.Offset != 0 {
				return nil, failure("file_transfer_missing", "A transferência não existe ou expirou.")
			}
			if len(e.uploads) >= 16 {
				return nil, failure("file_transfer_limit", "O limite de transferências simultâneas foi atingido.")
			}
			if !a.Overwrite {
				if _, err = root.Lstat(name); err == nil {
					return nil, failure("file_exists", "O destino já existe. A substituição precisa ser solicitada.")
				} else if !errors.Is(err, os.ErrNotExist) {
					return nil, err
				}
			}
			held, err := root.OpenRoot(".")
			if err != nil {
				return nil, err
			}
			unlock, err := acquireTransferLock(held, name)
			if err != nil {
				held.Close()
				return nil, err
			}
			f, err := openUploadPart(held, name)
			if err != nil {
				unlock()
				held.Close()
				return nil, err
			}
			u = &upload{unlock: unlock, updated: time.Now(), root: held, file: f, name: name, hash: sha256.New(), overwrite: a.Overwrite, expected: a.Size, transferID: a.TransferID}
			e.uploads[key] = u
			u.expiry = time.AfterFunc(e.config.transferIdleTimeout, func() { e.expireUpload(key, u) })
		}
		if a.TransferID != u.transferID || a.Offset != u.size || a.Overwrite != u.overwrite || a.Size != u.expected {
			return nil, failure("file_transfer_mismatch", "O bloco não corresponde à transferência em andamento.")
		}
		abort := func() { e.releaseUpload(key, u, true) }
		if u.expected > 0 && u.size+int64(len(a.Data)) > u.expected {
			abort()
			return nil, failure("file_size_mismatch", "Os bytes recebidos ultrapassam o tamanho declarado.")
		}
		n, err := u.file.Write(a.Data)
		if err != nil {
			abort()
			return nil, err
		}
		u.hash.Write(a.Data[:n])
		u.size += int64(n)
		u.updated = time.Now()
		if !a.Final {
			return map[string]any{"size": u.size, "complete": false}, nil
		}
		hash := hex.EncodeToString(u.hash.Sum(nil))
		if hash != a.SHA256 || (u.expected > 0 && u.expected != u.size) {
			abort()
			return nil, failure("file_hash_mismatch", "O hash ou o tamanho final não corresponde ao arquivo recebido.")
		}
		if err = u.file.Sync(); err != nil {
			abort()
			return nil, err
		}
		u.info, _ = u.file.Stat()
		if err = u.file.Close(); err != nil {
			abort()
			return nil, err
		}
		if u.overwrite {
			err = u.root.Rename(u.name+".cialai-part", u.name)
		} else {
			err = u.root.Link(u.name+".cialai-part", u.name)
			if err == nil {
				err = u.root.Remove(u.name + ".cialai-part")
			}
		}
		if err != nil {
			abort()
			return nil, err
		}
		e.releaseUpload(key, u, false)
		return map[string]any{"size": u.size, "sha256": hash, "complete": true}, nil
	}
	return nil, failure("file_unsupported", "A operação de arquivo não é suportada.")
}

func (e *Executor) getFile(root *os.Root, name, key string, a fileArgs, limit int64) (any, error) {
	if a.Length <= 0 || a.Length > 1<<20 {
		return nil, failure("file_invalid_range", "O tamanho do bloco é inválido.")
	}
	key += "\x00" + a.TransferID
	d := e.downloads[key]
	if d == nil {
		if a.Offset != 0 {
			return nil, failure("file_transfer_missing", "A transferência não existe ou expirou.")
		}
		if len(e.downloads) >= 16 {
			return nil, failure("file_transfer_limit", "O limite de transferências simultâneas foi atingido.")
		}
		f, err := root.Open(name)
		if err != nil {
			return nil, err
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > limit {
			f.Close()
			return nil, failure("file_size_limit", "O arquivo não é comum ou ultrapassa o limite local.")
		}
		d = &download{file: f, info: info, hash: sha256.New()}
		e.downloads[key] = d
	}
	abort := func() { d.file.Close(); delete(e.downloads, key) }
	if a.Offset != d.offset {
		return nil, failure("file_transfer_mismatch", "A posição não corresponde à transferência em andamento.")
	}
	info, err := d.file.Stat()
	if err != nil {
		abort()
		return nil, err
	}
	if info.Size() != d.info.Size() || !info.ModTime().Equal(d.info.ModTime()) {
		abort()
		return nil, failure("file_changed", "O arquivo mudou durante a transferência.")
	}
	data := make([]byte, a.Length)
	n, err := d.file.Read(data)
	if err != nil && err != io.EOF {
		abort()
		return nil, err
	}
	data = data[:n]
	d.hash.Write(data)
	d.offset += int64(n)
	d.updated = time.Now()
	eof := d.offset >= d.info.Size()
	chunk := sha256.Sum256(data)
	out := map[string]any{"data": data, "eof": eof, "next_offset": d.offset, "size": d.info.Size(), "chunk_sha256": hex.EncodeToString(chunk[:])}
	if eof {
		out["sha256"] = hex.EncodeToString(d.hash.Sum(nil))
		abort()
	}
	return out, nil
}
