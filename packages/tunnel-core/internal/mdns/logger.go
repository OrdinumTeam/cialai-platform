// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"fmt"
	"sync"
	"time"

	"github.com/pion/logging"
)

// warningInterval limits each kind of pion warning to one line per interval:
// pion warns per packet, and a busy network would flood the bounded log.
const warningInterval = time.Minute

// loggerFactory forwards pion warnings and errors to Logf and drops the rest.
type loggerFactory struct {
	logf func(format string, args ...any)

	mu   sync.Mutex
	last map[string]time.Time
}

var _ logging.LoggerFactory = (*loggerFactory)(nil)

func newLoggerFactory(logf func(format string, args ...any)) *loggerFactory {
	return &loggerFactory{logf: logf, last: make(map[string]time.Time)}
}

func (factory *loggerFactory) NewLogger(string) logging.LeveledLogger {
	return pionLogger{factory: factory}
}

// forward logs message unless another one with the same kind, the format
// before its arguments, was logged within warningInterval.
func (factory *loggerFactory) forward(kind, message string) {
	now := time.Now()
	factory.mu.Lock()
	if last, seen := factory.last[kind]; seen && now.Sub(last) < warningInterval {
		factory.mu.Unlock()
		return
	}
	factory.last[kind] = now
	factory.mu.Unlock()
	factory.logf("mdns: pion: %s", message)
}

type pionLogger struct{ factory *loggerFactory }

func (pionLogger) Trace(string)          {}
func (pionLogger) Tracef(string, ...any) {}
func (pionLogger) Debug(string)          {}
func (pionLogger) Debugf(string, ...any) {}
func (pionLogger) Info(string)           {}
func (pionLogger) Infof(string, ...any)  {}

func (logger pionLogger) Warn(message string) { logger.factory.forward(message, message) }
func (logger pionLogger) Warnf(format string, args ...any) {
	logger.factory.forward(format, fmt.Sprintf(format, args...))
}
func (logger pionLogger) Error(message string) { logger.factory.forward(message, message) }
func (logger pionLogger) Errorf(format string, args ...any) {
	logger.factory.forward(format, fmt.Sprintf(format, args...))
}
