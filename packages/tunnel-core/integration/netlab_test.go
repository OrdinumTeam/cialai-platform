// SPDX-License-Identifier: Apache-2.0
//go:build netlab

package integration_test

// TestNetLabNATAndFallback runs the seven scenarios of CON-031 in
// tools/net-lab: the real cialai-tunnel sidecar behind a Linux NAT router,
// headless phones around the mobile package behind another router or on the
// desktop LAN, coturn as STUN and a simulated Tor network for the fallback.
//
//	go test -tags=netlab -count=1 -timeout=25m -v ./integration -run NetLab
//
// Every scenario sets the routers it needs, pairs a new phone with a QR from
// pair.begin and records the path chosen and the time of each step in
// report.txt and report.json, under NETLAB_ARTIFACTS when it is set.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

const (
	phoneLANAddress = "10.231.1.20"
	phonePublic     = "203.0.113.12"
	desktopPublic   = "203.0.113.11"
)

func TestNetLabNATAndFallback(t *testing.T) {
	lab := startNetLab(t)
	desktop := lab.startDesktop(t)
	t.Cleanup(desktop.close)
	defer lab.report(t)
	status := desktop.startNetwork(t)
	t.Logf("computador %s pronto: direto %v, STUN %s %s, onion %s", status.Desktop.ID, status.Direct.Candidates, status.Direct.STUN.State, status.Direct.STUN.Addr, status.Tor.Onion)
	if status.Direct.STUN.Addr != desktopPublic+":4740" {
		t.Fatalf("o STUN do laboratório devolveu %q, esperado o IP público do roteador cone", status.Direct.STUN.Addr)
	}

	t.Run("lan_direta", func(t *testing.T) { scenarioLAN(t, lab, desktop) })
	t.Run("cone_com_cone", func(t *testing.T) { scenarioConeCone(t, lab, desktop) })
	t.Run("simetrico_com_cone_reserva", func(t *testing.T) { scenarioSymmetric(t, lab, desktop) })
	t.Run("udp_bloqueado_reserva", func(t *testing.T) { scenarioUDPBlocked(t, lab, desktop) })
	t.Run("revogacao", func(t *testing.T) { scenarioRevocation(t, lab, desktop) })
	t.Run("reinicio_do_sidecar", func(t *testing.T) { scenarioSidecarRestart(t, lab, desktop, status) })
	t.Run("reinicio_do_tor", func(t *testing.T) { scenarioTorRestart(t, lab, desktop) })
	// Last: it spends the pairing attempts of the minute on both origins.
	t.Run("protecoes_do_pareamento", func(t *testing.T) { scenarioPairingProtections(t, lab, desktop) })
}

// openNetwork puts both routers in cone mode with UDP open and refreshes the
// desktop candidates, since a router change drops its mappings.
func openNetwork(t *testing.T, lab *netLab, desktop *labDesktop) {
	t.Helper()
	lab.setRouter(t, "router-desktop", "cone", false)
	lab.setRouter(t, "router-phone", "cone", false)
	desktop.call(t, "net.refresh", map[string]any{}, nil)
}

func sessionOf(deviceID string) func(json.RawMessage) bool {
	return func(data json.RawMessage) bool { return field(data, "deviceId") == deviceID }
}

func pathIs(path string) func(json.RawMessage) bool {
	return func(data json.RawMessage) bool { return field(data, "path") == path }
}

func ms(value int64) time.Duration { return time.Duration(value) * time.Millisecond }

// pairAndOpen pairs phone, connects, opens the page and runs the first echo,
// checking the path at each step and the session the desktop saw.
func pairAndOpen(t *testing.T, result *scenarioResult, desktop *labDesktop, phone *labPhone, transport, path string) pairResult {
	t.Helper()
	from := desktop.mark()
	paired := phone.pair(t, desktop)
	if paired.Transport != transport {
		t.Fatalf("pareamento por %q, esperado %q", paired.Transport, transport)
	}
	result.step(t, "pareamento pelo QR", paired.elapsed, "transporte "+paired.Transport)
	desktop.waitEvent(t, from, "pair.completed", "pair.completed", func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID) && field(data, "transport") == transport
	})
	connected := phone.connect(t, paired.DesktopID)
	if connected.Path != path || connected.Transport != transport {
		t.Fatalf("Connect escolheu %s por %s, esperado %s por %s", connected.Path, connected.Transport, path, transport)
	}
	result.step(t, "Connect", ms(connected.Elapsed), "caminho "+connected.Path)
	phone.open(t, paired)
	from = desktop.mark()
	echo := phone.echo(t, "primeiro eco")
	opened, _, _ := desktop.waitEvent(t, from, "session.opened", "session.opened", sessionOf(paired.DeviceID))
	if field(opened, "transport") != transport {
		t.Fatalf("a ponte recebeu o socket por %s: %s", field(opened, "transport"), opened)
	}
	result.step(t, "WebSocket e eco pela ponte", echo, "remoto "+orNone(field(opened, "remoteAddr")))
	result.Path = path + " por " + transport
	return paired
}

func orNone(value string) string {
	if value == "" {
		return "sem endereço (onion)"
	}
	return value
}

// scenarioLAN: phone on the desktop network, QR candidates dialed directly.
func scenarioLAN(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "lan_direta")
	openNetwork(t, lab, desktop)
	phone := lab.startPhone(t, "phone-lan", "lan")
	phone.must(t, "tor", map[string]any{"enabled": true})
	from := desktop.mark()
	pairAndOpen(t, result, desktop, phone, "direct", "lan")
	opened, _ := desktop.findEvent(from, "session.opened", nil)
	if !strings.HasPrefix(field(opened, "remoteAddr"), phoneLANAddress+":") {
		t.Fatalf("sessão local veio de %s", field(opened, "remoteAddr"))
	}
}

// scenarioConeCone: phone on another network, both routers cone. The phone
// reaches the reflexive candidate STUN gave the desktop; the punch through
// the fallback channel is CON-032.
func scenarioConeCone(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "cone_com_cone")
	openNetwork(t, lab, desktop)
	phone := lab.startPhone(t, "phone", "cone")
	phone.must(t, "tor", map[string]any{"enabled": true})
	from := desktop.mark()
	pairAndOpen(t, result, desktop, phone, "direct", "direct")
	opened, _ := desktop.findEvent(from, "session.opened", nil)
	if !strings.HasPrefix(field(opened, "remoteAddr"), phonePublic+":") {
		t.Fatalf("a sessão direta não atravessou o NAT do celular: remoto %s", field(opened, "remoteAddr"))
	}
	result.note(t, "caminho direto pelo candidato refletido %s:4740 do STUN; o furo coordenado pela reserva depende de CON-032", desktopPublic)
}

// scenarioSymmetric: the desktop behind a symmetric NAT. Its reflexive
// candidate only exists toward the STUN server, so the phone behind a cone
// router falls back to the simulated Tor network.
func scenarioSymmetric(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "simetrico_com_cone_reserva")
	lab.setRouter(t, "router-desktop", "symmetric", false)
	lab.setRouter(t, "router-phone", "cone", false)
	t.Cleanup(func() { openNetwork(t, lab, desktop) })
	var refreshed netStatus
	desktop.call(t, "net.refresh", map[string]any{}, &refreshed)
	result.note(t, "candidatos do computador atrás do NAT simétrico: %v", refreshed.Direct.Candidates)
	phone := lab.startPhone(t, "phone", "simetrico")
	phone.must(t, "tor", map[string]any{"enabled": true})
	mark := phone.mark()
	pairAndOpen(t, result, desktop, phone, "tor", "tor")
	if states := pairStates(phone, mark); !strings.Contains(states, "direct") || !strings.HasSuffix(states, "tor,confirming,completed") {
		t.Fatalf("o pareamento não tentou o direto antes da reserva: %s", states)
	}
	result.note(t, "sem furo pela reserva: o passo 4 da seção 6.3 depende de CON-032")
}

func pairStates(phone *labPhone, from int) string {
	var states []string
	phone.find(from, func(raw json.RawMessage) bool {
		if field(raw, "event") == "pair" {
			var frame struct {
				Data json.RawMessage `json:"data"`
			}
			_ = json.Unmarshal(raw, &frame)
			states = append(states, field(frame.Data, "state"))
		}
		return false
	})
	return strings.Join(states, ",")
}

// scenarioUDPBlocked: the phone network drops UDP. A phone on the direct path
// moves to the fallback when its QUIC session dies, and a phone starting from
// zero goes straight to it after the direct budget.
func scenarioUDPBlocked(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "udp_bloqueado_reserva")
	openNetwork(t, lab, desktop)
	t.Cleanup(func() { lab.setRouter(t, "router-phone", "cone", false) })
	phone := lab.startPhone(t, "phone", "udp")
	phone.must(t, "tor", map[string]any{"enabled": true})
	paired := pairAndOpen(t, result, desktop, phone, "direct", "direct")
	phone.must(t, "hold", map[string]any{"name": "antes", "message": "socket aberto antes do bloqueio"})

	mark := phone.mark()
	from := desktop.mark()
	blocked := time.Now()
	lab.setRouter(t, "router-phone", "cone", true)
	switched, at := phone.waitEvent(t, mark, "path", "troca para a reserva", pathIs("tor"))
	if field(switched, "reason") != "path_failed" {
		t.Fatalf("troca para a reserva com motivo %s", switched)
	}
	result.step(t, "queda do QUIC até a reserva ativa", at.Sub(blocked), "motivo "+field(switched, "reason"))
	if closed, _ := phone.waitEvent(t, mark, "socket", "socket antigo fechado", nil); field(closed, "name") != "antes" {
		t.Fatalf("socket fechado: %s", closed)
	}
	attempts, recovered := phone.echoUntil(t, blocked, 90*time.Second)
	opened, _, _ := desktop.waitEvent(t, from, "session.opened", "sessão pela reserva", sessionOf(paired.DeviceID))
	if field(opened, "transport") != "tor" {
		t.Fatalf("a página religou por %s", opened)
	}
	result.step(t, "página religada pela reserva", recovered, "tentativas "+itoa(attempts))

	// From zero, with UDP still blocked.
	phone.must(t, "stop", nil)
	connected := phone.connect(t, paired.DesktopID)
	if connected.Path != "tor" {
		t.Fatalf("Connect do zero com UDP bloqueado escolheu %+v", connected)
	}
	result.step(t, "Connect do zero com UDP bloqueado", ms(connected.Elapsed), "caminho tor")
	phone.open(t, paired)
	result.step(t, "eco pela reserva", phone.echo(t, "reserva"), "")
	result.Path = "direct, depois tor"
}

// scenarioRevocation: devices.revoke closes the session and the socket with
// 4401, and the desktop refuses the phone on a new connection after an app
// restart, over the direct path and over the fallback.
func scenarioRevocation(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "revogacao")
	openNetwork(t, lab, desktop)
	t.Cleanup(func() { lab.setRouter(t, "router-phone", "cone", false) })
	phone := lab.startPhone(t, "phone", "revogado")
	phone.must(t, "tor", map[string]any{"enabled": true})
	paired := pairAndOpen(t, result, desktop, phone, "direct", "direct")
	phone.must(t, "hold", map[string]any{"name": "aberto", "message": "antes da revogação"})

	mark := phone.mark()
	from := desktop.mark()
	started := time.Now()
	var revoked struct {
		Sessions int `json:"sessions"`
		Sockets  int `json:"sockets"`
	}
	desktop.call(t, "devices.revoke", map[string]any{"deviceId": paired.DeviceID}, &revoked)
	// The phone usually closes its QUIC session on the 4401 close before the
	// edge closes the key, so zero sessions left for the edge is expected.
	result.step(t, "devices.revoke", time.Since(started), "sessões fechadas pela borda "+itoa(revoked.Sessions)+", sockets "+itoa(revoked.Sockets))
	closed, closedAt := phone.waitEvent(t, mark, "socket", "socket revogado", nil)
	if field(closed, "closeStatus") != "4401" {
		t.Fatalf("o socket aberto fechou sem 4401: %s", closed)
	}
	result.step(t, "socket fechado com 4401", closedAt.Sub(started), "")
	gone, goneAt := phone.waitEvent(t, mark, "path", "caminho revogado", pathIs("none"))
	if field(gone, "reason") != "revoked" {
		t.Fatalf("evento de caminho %s", gone)
	}
	result.step(t, "gerenciador de caminho revogado", goneAt.Sub(started), "")
	desktop.waitEvent(t, from, "session.closed", "session.closed", func(data json.RawMessage) bool {
		return field(data, "deviceId") == paired.DeviceID && field(data, "reason") == "revoked"
	})
	if reply := phone.request(t, "connect", map[string]any{"desktopId": paired.DesktopID}); reply.OK || reply.code() != "revoked" {
		t.Fatalf("Connect depois da revogação: %+v", reply)
	}
	var listed struct {
		Devices []struct {
			ID         string   `json:"id"`
			Revoked    bool     `json:"revoked"`
			Connected  bool     `json:"connected"`
			Transports []string `json:"transports"`
		} `json:"devices"`
	}
	desktop.call(t, "devices.list", map[string]any{}, &listed)
	for _, device := range listed.Devices {
		if device.ID == paired.DeviceID && (!device.Revoked || device.Connected) {
			t.Fatalf("registro depois da revogação: %+v", device)
		}
	}

	// The app restarts with the same identity and remembered card: the
	// desktop refuses the key on a new QUIC handshake.
	phone.close()
	mark0 := desktop.mark()
	restarted := lab.startPhone(t, "phone", "revogado")
	restarted.must(t, "tor", map[string]any{"enabled": true})
	started = time.Now()
	refusal := refused(t, restarted, paired.DesktopID)
	result.step(t, "nova conexão direta recusada", time.Since(started), refusal)
	if strings.HasPrefix(refusal, "Connect aceito") {
		result.note(t, "pendência: Connect de um celular revogado devolve sucesso pelo QUIC antes de a recusa do computador fechar a sessão; o gerenciador passa a revoked logo depois")
	}

	// Over the fallback Tor carries no close code: the onion listener drops
	// the revoked key and the page never reaches the bridge.
	restarted.close()
	lab.setRouter(t, "router-phone", "cone", true)
	again := lab.startPhone(t, "phone", "revogado")
	again.must(t, "tor", map[string]any{"enabled": true})
	started = time.Now()
	reply := again.request(t, "connect", map[string]any{"desktopId": paired.DesktopID})
	detail := "Connect " + reply.code()
	if reply.OK {
		again.open(t, paired)
		echo := again.request(t, "echo", map[string]any{"message": "revogado pela reserva"})
		if echo.OK {
			t.Fatal("um celular revogado abriu um socket pela reserva")
		}
		detail = "Connect aceito pela reserva, socket recusado: " + echo.code()
	}
	if opened, found := desktop.findEvent(mark0, "session.opened", sessionOf(paired.DeviceID)); found {
		t.Fatalf("o computador abriu sessão para o celular revogado: %s", opened)
	}
	result.step(t, "nova conexão pela reserva recusada", time.Since(started), detail)
	result.Path = "direct, revogado"
}

// scenarioSidecarRestart: the sidecar ends and the supervisor starts it again,
// first like an app restart and then like a crash. The phone reaches the same
// identity and onion with the stored token, without a QR.
func scenarioSidecarRestart(t *testing.T, lab *netLab, desktop *labDesktop, initial netStatus) {
	result := lab.scenario(t, "reinicio_do_sidecar")
	openNetwork(t, lab, desktop)
	phone := lab.startPhone(t, "phone", "reinicio")
	phone.must(t, "tor", map[string]any{"enabled": true})
	paired := pairAndOpen(t, result, desktop, phone, "direct", "direct")
	var paths []string
	for index, signal := range []string{"TERM", "KILL"} {
		if index > 0 {
			// The previous variant left the phone on the fallback, where
			// hysteresis keeps it; an app restart puts it back on direct.
			phone.must(t, "stop", nil)
			if connected := phone.connect(t, paired.DesktopID); connected.Path != "direct" {
				t.Fatalf("o celular não voltou ao direto antes de %s: %+v", signal, connected)
			}
			phone.open(t, paired)
			phone.echo(t, "direto antes de "+signal)
		}
		mark := phone.mark()
		from := desktop.mark()
		started := time.Now()
		status, elapsed := desktop.restartSidecar(t, signal)
		if status.Desktop.ID != initial.Desktop.ID || status.Tor.Onion != initial.Tor.Onion {
			t.Fatalf("o sidecar voltou com outra identidade: %s %s", status.Desktop.ID, status.Tor.Onion)
		}
		result.step(t, "sidecar de pé de novo após "+signal, elapsed, "mesma identidade e onion")
		attempts, recovered := phone.echoUntil(t, started, 2*time.Minute)
		opened, _, _ := desktop.waitEvent(t, from, "session.opened", "sessão depois do reinício", sessionOf(paired.DeviceID))
		_, path, transport := phone.status(t)
		result.step(t, "eco sem QR após "+signal, recovered, "caminho "+path+" por "+transport+", tentativas "+itoa(attempts)+", ponte por "+field(opened, "transport"))
		paths = append(paths, signal+": "+path)
		if _, found := desktop.findEvent(from, "pair.completed", nil); found {
			t.Fatal("o reinício exigiu um novo pareamento")
		}
		if events := countEvents(phone, mark, "path"); events == 0 {
			result.note(t, "após %s o celular religou sem evento de caminho", signal)
		}
	}
	var listed struct {
		Devices []struct {
			ID      string `json:"id"`
			Revoked bool   `json:"revoked"`
		} `json:"devices"`
	}
	desktop.call(t, "devices.list", map[string]any{}, &listed)
	found := false
	for _, device := range listed.Devices {
		found = found || (device.ID == paired.DeviceID && !device.Revoked)
	}
	if !found {
		t.Fatalf("o celular sumiu do registro depois do reinício: %+v", listed.Devices)
	}
	result.Path = strings.Join(paths, "; ")
}

// refused checks that the desktop refuses a phone whose key was revoked: the
// path manager ends revoked, right away or after the QUIC session it adopted
// is closed by the listener, and a new Connect fails with revoked.
func refused(t *testing.T, phone *labPhone, desktopID string) string {
	t.Helper()
	mark := phone.mark()
	reply := phone.request(t, "connect", map[string]any{"desktopId": desktopID})
	detail := "Connect " + reply.code()
	if reply.OK {
		accepted := time.Now()
		_, at := phone.waitEvent(t, mark, "path", "recusa do celular revogado", func(data json.RawMessage) bool {
			return field(data, "path") == "none" && field(data, "reason") == "revoked"
		})
		detail = "Connect aceito pelo QUIC, revoked " + max(0, at.Sub(accepted)).Round(time.Millisecond).String() + " depois da resposta"
	} else if reply.code() != "revoked" {
		t.Fatalf("Connect de um celular revogado: %+v", reply)
	}
	if again := phone.request(t, "connect", map[string]any{"desktopId": desktopID}); again.OK || again.code() != "revoked" {
		t.Fatalf("segundo Connect de um celular revogado: %+v", again)
	}
	return detail
}

func countEvents(phone *labPhone, from int, kind string) int {
	count := 0
	phone.find(from, func(raw json.RawMessage) bool {
		if field(raw, "event") == kind {
			count++
		}
		return false
	})
	return count
}

// scenarioTorRestart: a phone that only has the fallback keeps working after
// the tor process of the desktop dies and after the simulated Tor network
// restarts, while a phone on the direct path is not disturbed.
func scenarioTorRestart(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "reinicio_do_tor")
	openNetwork(t, lab, desktop)
	t.Cleanup(func() { lab.setRouter(t, "router-phone", "cone", false) })
	lab.setRouter(t, "router-phone", "cone", true)
	phone := lab.startPhone(t, "phone", "tor")
	phone.must(t, "tor", map[string]any{"enabled": true})
	pairAndOpen(t, result, desktop, phone, "tor", "tor")
	local := lab.startPhone(t, "phone-lan", "tor-lan")
	local.must(t, "tor", map[string]any{"enabled": true})
	lanResult := &scenarioResult{Name: result.Name}
	pairAndOpen(t, lanResult, desktop, local, "direct", "lan")
	local.must(t, "hold", map[string]any{"name": "direto", "message": "sessão direta durante o reinício do tor"})
	localMark := local.mark()

	from := desktop.mark()
	started := time.Now()
	// Only the tor child: the sidecar command line also names the binary.
	lab.exec(t, "desktop", "pkill", "-KILL", "-f", "^/opt/netlab/tor/tor -f ")
	restarting, _, restartingAt := desktop.waitEvent(t, from, "tor.state", "tor reiniciando", func(data json.RawMessage) bool {
		return field(data, "error") == "tor_restarting"
	})
	result.step(t, "supervisor viu o tor cair", restartingAt.Sub(started), field(restarting, "state"))
	_, _, publishedAt := desktop.waitEvent(t, from, "tor.state", "onion republicado", func(data json.RawMessage) bool {
		return field(data, "published") == "true"
	})
	result.step(t, "onion republicado com a mesma chave", publishedAt.Sub(started), "")
	attempts, recovered := phone.echoUntil(t, started, 2*time.Minute)
	result.step(t, "eco pela reserva depois do tor", recovered, "tentativas "+itoa(attempts))

	// The simulated Tor network restarts. The tor child reconnects and
	// publishes again by itself; the sidecar state stays published, as with a
	// real tor rebuilding its circuits, so only the phone tells the recovery.
	started = time.Now()
	if out, err := lab.composeRun("restart", "--timeout", "1", "relay"); err != nil {
		t.Fatalf("reinício da rede Tor simulada: %v\n%s", err, out)
	}
	result.step(t, "rede Tor simulada reiniciada", time.Since(started), "")
	attempts, recovered = phone.echoUntil(t, started, 2*time.Minute)
	result.step(t, "eco pela reserva depois da rede", recovered, "tentativas "+itoa(attempts))

	if closed, found := local.findEvent(localMark, "socket", nil); found {
		t.Fatalf("o socket direto caiu com o tor: %s", closed)
	}
	if moved, found := local.findEvent(localMark, "path", nil); found {
		t.Fatalf("o celular no caminho direto mudou de caminho com o tor: %s", moved)
	}
	result.step(t, "celular na LAN sem troca de caminho", time.Since(started), "socket direto aberto")
	result.Path = "tor; lan intacto"
}

func itoa(value int) string { return strconv.Itoa(value) }

// scenarioPairingProtections runs part of CON-060 through the phone API and
// the real sidecar, across the NAT over the direct path and with UDP blocked
// over the fallback: the photo of a used QR, the four digit approval denied
// on the desktop and the limit of pairing attempts per minute. Each refusal
// carries its code to the phone and pair.failed to the desktop. Expiry, the
// ten failure block, rotation and the TLS key mismatch are covered with the
// pairing clock in internal/edge and internal/sidecar.
func scenarioPairingProtections(t *testing.T, lab *netLab, desktop *labDesktop) {
	result := lab.scenario(t, "protecoes_do_pareamento")
	openNetwork(t, lab, desktop)
	t.Cleanup(func() {
		desktop.setApproval(t, false)
		lab.setRouter(t, "router-phone", "cone", false)
	})
	for _, name := range []string{"direct", "tor"} {
		lab.setRouter(t, "router-phone", "cone", name == "tor")
		owner := lab.startPhone(t, "phone", "dono-"+name)
		owner.must(t, "tor", map[string]any{"enabled": true})
		other := lab.startPhone(t, "phone", "outro-"+name)
		other.must(t, "tor", map[string]any{"enabled": true})

		payload := desktop.pairBegin(t)
		if paired := owner.pairPayload(t, payload); paired.Transport != name {
			t.Fatalf("o dono pareou por %s", paired.Transport)
		}
		// The dialog already shows the next QR when the photo is used.
		desktop.pairBegin(t)
		mark := desktop.mark()
		reply := other.request(t, "pair", map[string]any{"payload": payload})
		expectRefusal(t, desktop, mark, reply, "pair_consumed", name)
		result.step(t, name+": foto do QR usado", ms(reply.MS), "celular "+reply.code()+", computador pair.failed")

		desktop.setApproval(t, true)
		payload = desktop.pairBegin(t)
		mark = desktop.mark()
		waitReply := other.requestAsync(t, "pair", map[string]any{"payload": payload})
		requested, _, _ := desktop.waitEvent(t, mark, "pair.requested", "pedido de aprovação", func(data json.RawMessage) bool {
			return field(data, "transport") == name
		})
		code := field(requested, "code")
		if _, err := strconv.Atoi(code); err != nil || len(code) != 4 {
			t.Fatalf("pair.requested sem código de quatro dígitos: %s", requested)
		}
		desktop.call(t, "pair.deny", map[string]any{"pairId": field(requested, "pairId")}, nil)
		reply = waitReply()
		expectRefusal(t, desktop, mark, reply, "pair_denied", name)
		result.step(t, name+": aprovação por código negada", ms(reply.MS), "código "+code+", celular "+reply.code())
		desktop.setApproval(t, false)

		// Wrong secrets until the edge limits the origin: at most the sixth
		// request of the minute, counting the pairings above.
		guessed := guessedQR(t, desktop.pairBegin(t), name == "tor")
		limited := 0
		for attempt := 1; attempt <= 6 && limited == 0; attempt++ {
			mark = desktop.mark()
			reply = other.request(t, "pair", map[string]any{"payload": guessed})
			switch reply.code() {
			case "pair_secret_mismatch":
				expectRefusal(t, desktop, mark, reply, "pair_secret_mismatch", name)
			case "pair_rate_limited":
				expectRefusal(t, desktop, mark, reply, "pair_rate_limited", name)
				limited = attempt
			default:
				t.Fatalf("tentativa %d com segredo errado: %+v", attempt, reply)
			}
		}
		if limited == 0 {
			t.Fatal("seis pedidos no mesmo minuto não foram limitados")
		}
		result.step(t, name+": limite de tentativas por minuto", ms(reply.MS), "pair_rate_limited na tentativa "+itoa(limited)+" com segredo errado")
		owner.close()
		other.close()
	}
	result.Path = "direct e tor"
}

// guessedQR keeps the desktop and onion of a real QR with a guessed secret;
// over the fallback it drops the direct candidates the blocked UDP would wait
// for.
func guessedQR(t *testing.T, payload string, onionOnly bool) string {
	t.Helper()
	decoded, err := pairing.Decode(payload)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	decoded.Secret = base64.RawURLEncoding.EncodeToString(secret)
	if onionOnly {
		decoded.Candidates = nil
	}
	encoded, err := pairing.Encode(decoded)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// expectRefusal checks the phone error code and the pair.failed event the
// desktop emitted for it on the transport.
func expectRefusal(t *testing.T, desktop *labDesktop, mark int, reply phoneReply, code, name string) {
	t.Helper()
	if reply.OK || reply.code() != code {
		t.Fatalf("esperado %s pelo celular, veio %+v", code, reply)
	}
	desktop.waitEvent(t, mark, "pair.failed", "pair.failed "+code, func(data json.RawMessage) bool {
		return field(data, "code") == code && field(data, "transport") == name
	})
}
