// SPDX-License-Identifier: Apache-2.0
package brotocli

import (
	"os"
	"strings"
)

func language() string {
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		v := strings.ToLower(os.Getenv(key))
		if v != "" {
			if strings.HasPrefix(v, "en") {
				return "en"
			}
			if strings.HasPrefix(v, "es") {
				return "es"
			}
			return "pt"
		}
	}
	return "pt"
}
func localize(s string) string {
	lang := language()
	if lang == "pt" {
		if v, ok := map[string]string{"connected": "conectado", "disconnected": "desconectado", "paused": "pausado", "free": "livre", "confirm": "confirmar IA", "read": "só acompanhar"}[s]; ok {
			return v
		}
		return s
	}
	index := 0
	if lang == "es" {
		index = 1
	}
	for original, pair := range messages {
		if s == original {
			return pair[index]
		}
		if strings.HasSuffix(original, ": ") && strings.HasPrefix(s, original) {
			return pair[index] + strings.TrimPrefix(s, original)
		}
	}
	return s
}

var messages = map[string][2]string{
	"O Cialai não está aberto neste computador.":  {"Cialai is not open on this computer.", "Cialai no está abierto en este equipo."},
	"Pedidos da IA aguardam aprovação no Cialai.": {"AI requests wait for approval in Cialai.", "Las solicitudes de la IA esperan aprobación en Cialai."},
	"Broto desconectado ou pausado":               {"Broto disconnected or paused", "Broto desconectado o pausado"},
	"Broto ambíguo ou inexistente: ":              {"Ambiguous or unknown Broto: ", "Broto ambiguo o desconocido: "},
	"opção exige valor":                           {"option requires a value", "la opción requiere un valor"},
	"opção desconhecida: ":                        {"unknown option: ", "opción desconocida: "},
	"informe o Broto":                             {"specify the Broto", "indique el Broto"},
	"prazo inválido":                              {"invalid timeout", "plazo inválido"},
	"informe uma linha de comando":                {"specify a command line", "indique una línea de comando"},
	"ação de terminal desconhecida":               {"unknown terminal action", "acción de terminal desconocida"},
	"informe a sessão":                            {"specify the session", "indique la sesión"},
	"sessão inválida":                             {"invalid session", "sesión inválida"},
	"informe o texto":                             {"specify the text", "indique el texto"},
	"informe o texto esperado":                    {"specify the expected text", "indique el texto esperado"},
	"informe a pasta":                             {"specify the folder", "indique la carpeta"},
	"informe origem e destino":                    {"specify source and destination", "indique origen y destino"},
	"informe origem e destino opcional":           {"specify source and optional destination", "indique origen y destino opcional"},
	"ação desconhecida":                           {"unknown action", "acción desconocida"},
	"sessão encerrou antes do texto":              {"session exited before the text appeared", "la sesión terminó antes de aparecer el texto"},
	"arquivo regular obrigatório":                 {"a regular file is required", "se requiere un archivo regular"},
	"hash final divergente":                       {"final hash mismatch", "el hash final no coincide"},
	"arquivo alterado durante envio":              {"file changed during upload", "el archivo cambió durante el envío"},
	"destino inválido":                            {"invalid destination", "destino inválido"},
	"destino já existe":                           {"destination already exists", "el destino ya existe"},
	"bloco corrompido":                            {"corrupt block", "bloque dañado"},
	"transferência sem progresso":                 {"transfer made no progress", "la transferencia no avanzó"},
	"uso: listar [--json]":                        {"usage: listar [--json]", "uso: listar [--json]"},
	"uso: cialai broto listar|rodar|terminal|arquivos|enviar|baixar": {"usage: cialai broto listar|rodar|terminal|arquivos|enviar|baixar", "uso: cialai broto listar|rodar|terminal|arquivos|enviar|baixar"},
	"connected": {"connected", "conectado"}, "disconnected": {"disconnected", "desconectado"}, "paused": {"paused", "pausado"}, "free": {"free", "libre"}, "confirm": {"confirm AI", "confirmar IA"}, "read": {"read only", "solo lectura"},
}
