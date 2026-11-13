package brotoexec

import (
	"context"
	"errors"
	"os"
	"os/exec"
)

// Error describes an execution failure without command, path, argument or
// environment content. Only these fixed descriptions may cross the wire.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string           { return e.Code + ": " + e.Message }
func failure(code, message string) error { return &Error{Code: code, Message: message} }
func Diagnostic(err error) string {
	var safe *Error
	if errors.As(err, &safe) {
		return safe.Error()
	}
	return "operation_failed: A operação falhou sem detalhes remotos."
}
func checkDirectory(dir string) error {
	if dir == "" {
		return nil
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return failure("working_directory_unavailable", "A pasta de execução não está disponível para esta conta.")
	}
	return nil
}
func startFailure(err error) error {
	var safe *Error
	if errors.As(err, &safe) {
		return safe
	}
	switch {
	case errors.Is(err, context.Canceled):
		return failure("execution_cancelled", "A execução foi cancelada antes de iniciar.")
	case errors.Is(err, context.DeadlineExceeded):
		return failure("execution_deadline", "O prazo terminou antes de iniciar o processo.")
	case errors.Is(err, os.ErrPermission):
		return failure("execution_permission_denied", "Esta conta não tem permissão para iniciar o processo.")
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		return failure("executable_unavailable", "O executável não está disponível para esta conta.")
	default:
		return failure("process_start_failed", "O sistema recusou iniciar o processo.")
	}
}

func fileFailure(err error) error {
	var safe *Error
	if errors.As(err, &safe) {
		return safe
	}
	switch {
	case errors.Is(err, os.ErrNotExist):
		return failure("file_not_found", "O arquivo ou a pasta não foi encontrado.")
	case errors.Is(err, os.ErrPermission):
		return failure("file_permission_denied", "Esta conta não tem permissão para acessar o arquivo.")
	case errors.Is(err, os.ErrExist):
		return failure("file_exists", "O destino já existe ou está em uso.")
	default:
		return failure("file_io_failed", "O sistema não conseguiu concluir a operação de arquivo.")
	}
}
