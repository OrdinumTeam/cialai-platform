// SPDX-License-Identifier: Apache-2.0
package brotorpc

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

const MaxFrame = 4 << 20

type Message struct {
	Actor   string          `json:"actor,omitempty"`
	ID      uint64          `json:"id,omitempty"`
	Cmd     string          `json:"cmd,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Event   string          `json:"event,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	Channel uint32          `json:"-"`
	Output  []byte          `json:"-"`
}

func Read(r io.Reader) (Message, error) {
	var h [4]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return Message{}, e
	}
	n := binary.BigEndian.Uint32(h[:])
	if n < 1 || n > MaxFrame {
		return Message{}, errors.New("invalid Broto frame size")
	}
	b := make([]byte, n)
	if _, e := io.ReadFull(r, b); e != nil {
		return Message{}, e
	}
	if b[0] == 1 {
		if len(b) < 5 {
			return Message{}, errors.New("short output frame")
		}
		return Message{Channel: binary.BigEndian.Uint32(b[1:5]), Output: b[5:]}, nil
	}
	if b[0] != 0 {
		return Message{}, errors.New("unknown frame type")
	}
	var m Message
	e := json.Unmarshal(b[1:], &m)
	return m, e
}
func Write(w io.Writer, m Message) error {
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	return writeFrame(w, append([]byte{0}, b...))
}
func WriteOutput(w io.Writer, ch uint32, b []byte) error {
	v := make([]byte, 5, len(b)+5)
	v[0] = 1
	binary.BigEndian.PutUint32(v[1:], ch)
	return writeFrame(w, append(v, b...))
}
func writeFrame(w io.Writer, b []byte) error {
	if len(b) > MaxFrame {
		return errors.New("Broto frame too large")
	}
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], uint32(len(b)))
	for _, part := range [][]byte{h[:], b} {
		for len(part) > 0 {
			n, e := w.Write(part)
			if e != nil {
				return e
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}
