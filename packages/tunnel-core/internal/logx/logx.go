// SPDX-License-Identifier: Apache-2.0
// Package logx emits redacted JSON logs and keeps a bounded in-memory tail.
package logx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

const Redacted = "[redacted]"

var (
	credentialPattern = regexp.MustCompile(`(?i)(hskey-|tskey-|nodekey:|privkey:|cdt1\.|cialai1\.)[a-z0-9._~-]+`)
	queryPattern      = regexp.MustCompile(`(?i)(secret|token|key)=([^&\s]+)`)
)

type Fields map[string]any

type Entry struct {
	Time    string `json:"ts"`
	Level   string `json:"level"`
	Message string `json:"message"`
	Fields  Fields `json:"fields,omitempty"`
}

type Logger struct {
	mu    sync.Mutex
	out   io.Writer
	limit int
	level int
	now   func() time.Time
	ring  []Entry
}

const (
	debugLevel = iota
	infoLevel
)

func New(output io.Writer, limit int) *Logger {
	if output == nil {
		output = io.Discard
	}
	if limit <= 0 {
		limit = 500
	}
	return &Logger{out: output, limit: limit, level: infoLevel, now: time.Now}
}

func (logger *Logger) SetClock(clock func() time.Time) {
	if clock == nil {
		return
	}
	logger.mu.Lock()
	logger.now = clock
	logger.mu.Unlock()
}

func (logger *Logger) SetLevel(level string) error {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "info", "":
		logger.level = infoLevel
	case "debug":
		logger.level = debugLevel
	default:
		return errors.New("log level must be info or debug")
	}
	return nil
}

func (logger *Logger) Debug(message string, fields Fields) {
	logger.write(debugLevel, "debug", message, fields)
}
func (logger *Logger) Info(message string, fields Fields) {
	logger.write(infoLevel, "info", message, fields)
}
func (logger *Logger) Warn(message string, fields Fields) {
	logger.write(infoLevel, "warn", message, fields)
}
func (logger *Logger) Error(message string, fields Fields) {
	logger.write(infoLevel, "error", message, fields)
}

func (logger *Logger) write(priority int, level, message string, fields Fields) {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	if priority < logger.level {
		return
	}
	entry := Entry{
		Time:    logger.now().UTC().Format(time.RFC3339Nano),
		Level:   level,
		Message: RedactText(message),
		Fields:  redactFields(fields),
	}
	line, err := json.Marshal(entry)
	if err != nil {
		entry.Fields = Fields{"serialization": Redacted}
		line, _ = json.Marshal(entry)
	}
	_, _ = logger.out.Write(append(line, '\n'))
	logger.ring = append(logger.ring, entry)
	if extra := len(logger.ring) - logger.limit; extra > 0 {
		copy(logger.ring, logger.ring[extra:])
		logger.ring = logger.ring[:logger.limit]
	}
}

func (logger *Logger) Tail(lines int) []Entry {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	if lines <= 0 || lines > len(logger.ring) {
		lines = len(logger.ring)
	}
	start := len(logger.ring) - lines
	result := make([]Entry, lines)
	for index := range lines {
		entry := logger.ring[start+index]
		entry.Fields = redactFields(entry.Fields)
		result[index] = entry
	}
	return result
}

func RedactText(value string) string {
	value = credentialPattern.ReplaceAllStringFunc(value, func(match string) string {
		for _, prefix := range []string{"hskey-", "tskey-", "nodekey:", "privkey:", "cdt1.", "cialai1."} {
			if strings.HasPrefix(strings.ToLower(match), prefix) {
				return match[:len(prefix)] + Redacted
			}
		}
		return Redacted
	})
	return queryPattern.ReplaceAllString(value, `${1}=`+Redacted)
}

func redactFields(fields Fields) Fields {
	if len(fields) == 0 {
		return nil
	}
	result := make(Fields, len(fields))
	for key, value := range fields {
		result[key] = redactValue(key, value)
	}
	return result
}

func redactValue(name string, value any) any {
	lower := strings.ToLower(name)
	if strings.Contains(lower, "secret") || strings.Contains(lower, "token") || strings.Contains(lower, "key") {
		return Redacted
	}
	switch typed := value.(type) {
	case string:
		return RedactText(typed)
	case Fields:
		return redactFields(typed)
	case map[string]any:
		return redactFields(Fields(typed))
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = redactValue("", item)
		}
		return result
	default:
		return value
	}
}

func (logger *Logger) Logf(level string) func(string, ...any) {
	return func(format string, args ...any) {
		message := fmt.Sprintf(format, args...)
		if level == "debug" {
			logger.Debug(message, nil)
			return
		}
		logger.Info(message, nil)
	}
}
