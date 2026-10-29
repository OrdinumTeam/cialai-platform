// SPDX-License-Identifier: Apache-2.0
package brotocli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func transferID() string {
	var b [16]byte
	_, e := rand.Read(b[:])
	if e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func fileCall(ctx context.Context, call Caller, device, verb string, a any) (json.RawMessage, error) {
	return call(ctx, "broto.call", encode(map[string]any{"deviceId": device, "cmd": verb, "args": a, "actor": "ai"}))
}
func cancelTransfer(call Caller, device, path, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = fileCall(ctx, call, device, "files.cancel", map[string]any{"path": path, "transfer_id": id})
}
func Upload(ctx context.Context, call Caller, device, source, dest string, overwrite bool, progress io.Writer) (result json.RawMessage, err error) {
	f, err := os.Open(source)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("arquivo regular obrigatório")
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return nil, err
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	id := transferID()
	defer func() {
		if err != nil {
			cancelTransfer(call, device, dest, id)
		}
	}()
	buf := make([]byte, 256<<10)
	offset := int64(0)
	for {
		n, re := io.ReadFull(f, buf)
		if re != nil && re != io.EOF && re != io.ErrUnexpectedEOF {
			return nil, re
		}
		final := offset+int64(n) == st.Size()
		chunk := sha256.Sum256(buf[:n])
		raw, e := fileCall(ctx, call, device, "files.put", map[string]any{"path": dest, "transfer_id": id, "offset": offset, "data": buf[:n], "size": st.Size(), "final": final, "sha256": sum, "chunk_sha256": hex.EncodeToString(chunk[:]), "overwrite": overwrite})
		if e != nil {
			return nil, e
		}
		offset += int64(n)
		if progress != nil {
			fmt.Fprintf(progress, "%d / %d bytes\n", offset, st.Size())
		}
		if final {
			var v struct {
				Complete bool   `json:"complete"`
				SHA      string `json:"sha256"`
			}
			if json.Unmarshal(raw, &v) != nil || !v.Complete || v.SHA != sum {
				return nil, errors.New("hash final divergente")
			}
			return raw, nil
		}
		if re != nil {
			return nil, errors.New("arquivo alterado durante envio")
		}
	}
}
func Download(ctx context.Context, call Caller, device, source, dest string, progress io.Writer) (result json.RawMessage, err error) {
	if dest == "" {
		dest = filepath.Base(strings.ReplaceAll(source, "\\", "/"))
	}
	if dest == "." || dest == "/" {
		return nil, errors.New("destino inválido")
	}
	if _, e := os.Lstat(dest); e == nil {
		return nil, errors.New("destino já existe")
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	stat, err := fileCall(ctx, call, device, "files.stat", map[string]any{"path": source})
	if err != nil {
		return nil, err
	}
	var expected struct {
		Type string `json:"type"`
		Size int64  `json:"size"`
		SHA  string `json:"sha256"`
	}
	if json.Unmarshal(stat, &expected) != nil || expected.Type != "file" || expected.Size < 0 || len(expected.SHA) != 64 {
		return nil, errors.New("invalid remote file metadata")
	}
	f, err := os.CreateTemp(filepath.Dir(dest), ".cialai-part-*")
	if err != nil {
		return nil, err
	}
	defer func() { f.Close(); os.Remove(f.Name()) }()
	id := transferID()
	defer func() {
		if err != nil {
			cancelTransfer(call, device, source, id)
		}
	}()
	hash := sha256.New()
	offset := int64(0)
	for {
		raw, e := fileCall(ctx, call, device, "files.get", map[string]any{"path": source, "transfer_id": id, "offset": offset, "length": 256 << 10, "size": expected.Size})
		if e != nil {
			return nil, e
		}
		var v struct {
			Data  []byte `json:"data"`
			EOF   bool   `json:"eof"`
			Next  int64  `json:"next_offset"`
			SHA   string `json:"sha256"`
			Chunk string `json:"chunk_sha256"`
			Size  int64  `json:"size"`
		}
		if e = json.Unmarshal(raw, &v); e != nil {
			return nil, e
		}
		sum := sha256.Sum256(v.Data)
		if v.Size != expected.Size || len(v.Data) > 256<<10 || v.Next > expected.Size || v.Next != offset+int64(len(v.Data)) || v.Chunk != hex.EncodeToString(sum[:]) {
			return nil, errors.New("bloco corrompido")
		}
		if len(v.Data) == 0 && !v.EOF {
			return nil, errors.New("transferência sem progresso")
		}
		if _, e = f.Write(v.Data); e != nil {
			return nil, e
		}
		hash.Write(v.Data)
		offset = v.Next
		if progress != nil {
			fmt.Fprintf(progress, "%d bytes\n", offset)
		}
		if v.EOF {
			if offset != expected.Size || v.SHA != expected.SHA || hex.EncodeToString(hash.Sum(nil)) != v.SHA {
				return nil, errors.New("hash final divergente")
			}
			if e = f.Sync(); e != nil {
				return nil, e
			}
			if e = f.Close(); e != nil {
				return nil, e
			}
			if e = os.Link(f.Name(), dest); e != nil {
				return nil, e
			}
			return encode(map[string]any{"path": dest, "size": offset, "sha256": v.SHA}), nil
		}
	}
}
