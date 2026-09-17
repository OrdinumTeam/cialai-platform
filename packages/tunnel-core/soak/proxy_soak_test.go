//go:build soak

// SPDX-License-Identifier: Apache-2.0
package soak

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/coder/websocket"
)

// soakDialer stands in for the path manager with one stable direct path to
// the loopback echo backend.
type soakDialer struct {
	endpoint string
	path     pathmgr.Path
	failures atomic.Uint64
}

func (dialer *soakDialer) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	var direct net.Dialer
	return direct.DialContext(ctx, network, dialer.endpoint)
}

func (dialer *soakDialer) Active() pathmgr.Path { return dialer.path }

func (dialer *soakDialer) ReportFailure(error) { dialer.failures.Add(1) }

type echoStats struct {
	accepted      atomic.Uint64
	disconnected  atomic.Uint64
	frames        atomic.Uint64
	payloadBytes  atomic.Uint64
	unexpectedErr atomic.Uint64
}

func (stats *echoStats) handler(response http.ResponseWriter, request *http.Request) {
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		stats.unexpectedErr.Add(1)
		return
	}
	connection.SetReadLimit(FrameBytes + 1024)
	stats.accepted.Add(1)
	defer func() {
		stats.disconnected.Add(1)
		_ = connection.CloseNow()
	}()
	for {
		kind, payload, err := connection.Read(request.Context())
		if err != nil {
			if !isNormalClose(err) {
				stats.unexpectedErr.Add(1)
			}
			return
		}
		stats.frames.Add(1)
		stats.payloadBytes.Add(uint64(len(payload)))
		if err := connection.Write(request.Context(), kind, payload); err != nil {
			if !isNormalClose(err) {
				stats.unexpectedErr.Add(1)
			}
			return
		}
	}
}

func isNormalClose(err error) bool {
	status := websocket.CloseStatus(err)
	return status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}

type memorySample struct {
	At             string `json:"at"`
	RSSBytes       uint64 `json:"rssBytes"`
	HeapAllocBytes uint64 `json:"heapAllocBytes"`
	HeapSysBytes   uint64 `json:"heapSysBytes"`
	Goroutines     int    `json:"goroutines"`
}

type soakReport struct {
	StartedAt               string         `json:"startedAt"`
	FinishedAt              string         `json:"finishedAt"`
	RequestedDuration       string         `json:"requestedDuration"`
	ElapsedMillis           int64          `json:"elapsedMillis"`
	Sockets                 int            `json:"sockets"`
	FrameBytes              int            `json:"frameBytes"`
	BurstBytes              int            `json:"burstBytes"`
	BurstInterval           string         `json:"burstInterval"`
	WarmupBursts            int            `json:"warmupBursts"`
	MeasuredBursts          int            `json:"measuredBursts"`
	MeasuredFrames          uint64         `json:"measuredFrames"`
	MeasuredPayloadBytes    uint64         `json:"measuredPayloadBytes"`
	EchoedPayloadBytes      uint64         `json:"echoedPayloadBytes"`
	ProxyDisconnects        uint64         `json:"proxyDisconnects"`
	BackendAccepted         uint64         `json:"backendAccepted"`
	BackendDisconnects      uint64         `json:"backendDisconnects"`
	BackendUnexpectedErrors uint64         `json:"backendUnexpectedErrors"`
	RSSStartBytes           uint64         `json:"rssStartBytes"`
	RSSEndBytes             uint64         `json:"rssEndBytes"`
	RSSPeakBytes            uint64         `json:"rssPeakBytes"`
	RSSGrowthBytes          int64          `json:"rssGrowthBytes"`
	HeapStartBytes          uint64         `json:"heapStartBytes"`
	HeapEndBytes            uint64         `json:"heapEndBytes"`
	HeapPeakBytes           uint64         `json:"heapPeakBytes"`
	HeapGrowthBytes         int64          `json:"heapGrowthBytes"`
	Samples                 []memorySample `json:"samples"`
	Failure                 string         `json:"failure,omitempty"`
}

func sampleMemory() memorySample {
	runtime.GC()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	return memorySample{
		At:             time.Now().UTC().Format(time.RFC3339Nano),
		RSSBytes:       currentRSS(),
		HeapAllocBytes: memory.HeapAlloc,
		HeapSysBytes:   memory.HeapSys,
		Goroutines:     runtime.NumGoroutine(),
	}
}

func currentRSS() uint64 {
	output, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(os.Getpid())).Output()
	if err != nil {
		return 0
	}
	kib, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0
	}
	return kib * 1024
}

func testDeviceToken() string {
	id := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	secret := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	return "cdt1.dev_" + id + "." + secret
}

func bootstrapCookie(ctx context.Context, opening proxy.OpenResult) (*http.Cookie, error) {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, opening.URL, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusFound {
		return nil, fmt.Errorf("bootstrap returned HTTP %d", response.StatusCode)
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == proxy.CookieName && cookie.HttpOnly && cookie.SameSite == http.SameSiteStrictMode {
			return cookie, nil
		}
	}
	return nil, errors.New("bootstrap did not return the strict proxy cookie")
}

func openSockets(ctx context.Context, opening proxy.OpenResult, cookie *http.Cookie) ([]*websocket.Conn, error) {
	endpoint := fmt.Sprintf("ws://127.0.0.1:%d/pty", opening.Port)
	origin := fmt.Sprintf("http://127.0.0.1:%d", opening.Port)
	connections := make([]*websocket.Conn, 0, SocketCount)
	for index := 0; index < SocketCount; index++ {
		connection, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{
			"Cookie": {cookie.String()},
			"Origin": {origin},
		}})
		if err != nil {
			closeSockets(connections)
			return nil, fmt.Errorf("open socket %d: %w", index+1, err)
		}
		connection.SetReadLimit(FrameBytes + 1024)
		connections = append(connections, connection)
	}
	return connections, nil
}

func closeSockets(connections []*websocket.Conn) {
	for _, connection := range connections {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = connection.Close(websocket.StatusNormalClosure, "soak complete")
		_ = connection.CloseRead(ctx)
		cancel()
	}
}

func runBurst(connections []*websocket.Conn, payload []byte) (uint64, error) {
	const frames = BurstBytes / FrameBytes
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	errorsFound := make(chan error, len(connections))
	var wait sync.WaitGroup
	for socket, connection := range connections {
		count := frames / len(connections)
		if socket < frames%len(connections) {
			count++
		}
		wait.Add(1)
		go func(socket, count int, connection *websocket.Conn) {
			defer wait.Done()
			for frame := 0; frame < count; frame++ {
				if err := connection.Write(ctx, websocket.MessageBinary, payload); err != nil {
					errorsFound <- fmt.Errorf("socket %d write frame %d: %w", socket+1, frame+1, err)
					return
				}
				kind, echoed, err := connection.Read(ctx)
				if err != nil {
					errorsFound <- fmt.Errorf("socket %d read frame %d: %w", socket+1, frame+1, err)
					return
				}
				if kind != websocket.MessageBinary || !bytes.Equal(echoed, payload) {
					errorsFound <- fmt.Errorf("socket %d received a corrupt frame", socket+1)
					return
				}
			}
		}(socket, count, connection)
	}
	wait.Wait()
	close(errorsFound)
	var joined error
	var disconnects uint64
	for err := range errorsFound {
		disconnects++
		joined = errors.Join(joined, err)
	}
	return disconnects, joined
}

func writeReport(path string, report any) error {
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}

func TestProxySoak(t *testing.T) {
	config, err := ConfigFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	stats := &echoStats{}
	backend := httptest.NewServer(http.HandlerFunc(stats.handler))
	defer backend.Close()
	backendAddress := strings.TrimPrefix(backend.URL, "http://")
	dialer := &soakDialer{
		endpoint: backendAddress,
		path:     pathmgr.Path{DesktopID: "desktop-soak", Transport: "direct", Kind: pathmgr.KindLAN, Since: time.Now()},
	}
	instance, err := proxy.New(proxy.Config{
		Dialer: dialer, DesktopID: "desktop-soak", DeviceToken: testDeviceToken(), ReadTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	opening, err := instance.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close(context.Background())
	setupContext, setupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	cookie, err := bootstrapCookie(setupContext, opening)
	if err != nil {
		setupCancel()
		t.Fatal(err)
	}
	connections, err := openSockets(setupContext, opening, cookie)
	setupCancel()
	if err != nil {
		t.Fatal(err)
	}
	defer closeSockets(connections)

	payload := bytes.Repeat([]byte{0xC1}, FrameBytes)
	if _, err := runBurst(connections, payload); err != nil {
		t.Fatalf("warmup burst failed: %v", err)
	}
	report := soakReport{
		StartedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		RequestedDuration: config.Duration.String(),
		Sockets:           SocketCount,
		FrameBytes:        FrameBytes,
		BurstBytes:        BurstBytes,
		BurstInterval:     config.BurstInterval.String(),
		WarmupBursts:      1,
	}
	first := sampleMemory()
	report.Samples = append(report.Samples, first)
	report.RSSStartBytes = first.RSSBytes
	report.HeapStartBytes = first.HeapAllocBytes
	started := time.Now()
	deadline := started.Add(config.Duration)
	for {
		disconnects, err := runBurst(connections, payload)
		if err != nil {
			report.ProxyDisconnects += disconnects
			report.Failure = err.Error()
			break
		}
		report.MeasuredBursts++
		report.MeasuredFrames += BurstBytes / FrameBytes
		report.MeasuredPayloadBytes += BurstBytes
		report.EchoedPayloadBytes += BurstBytes
		sample := sampleMemory()
		report.Samples = append(report.Samples, sample)
		report.RSSPeakBytes = max(report.RSSPeakBytes, sample.RSSBytes)
		report.HeapPeakBytes = max(report.HeapPeakBytes, sample.HeapAllocBytes)
		t.Logf("burst=%d payload=%d MiB rss=%d MiB heap=%d MiB goroutines=%d", report.MeasuredBursts, report.MeasuredPayloadBytes>>20, sample.RSSBytes>>20, sample.HeapAllocBytes>>20, sample.Goroutines)
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		pause := min(config.BurstInterval, remaining)
		timer := time.NewTimer(pause)
		<-timer.C
	}
	final := sampleMemory()
	report.Samples = append(report.Samples, final)
	report.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	report.ElapsedMillis = time.Since(started).Milliseconds()
	report.RSSEndBytes = final.RSSBytes
	report.HeapEndBytes = final.HeapAllocBytes
	report.RSSPeakBytes = max(report.RSSPeakBytes, first.RSSBytes, final.RSSBytes)
	report.HeapPeakBytes = max(report.HeapPeakBytes, first.HeapAllocBytes, final.HeapAllocBytes)
	report.RSSGrowthBytes = int64(report.RSSEndBytes) - int64(report.RSSStartBytes)
	report.HeapGrowthBytes = int64(report.HeapEndBytes) - int64(report.HeapStartBytes)
	report.BackendAccepted = stats.accepted.Load()
	report.BackendDisconnects = stats.disconnected.Load()
	report.BackendUnexpectedErrors = stats.unexpectedErr.Load()
	if failures := dialer.failures.Load(); failures != 0 && report.Failure == "" {
		report.Failure = fmt.Sprintf("proxy reported %d path failures", failures)
	}
	if err := writeReport(config.ReportPath, report); err != nil {
		t.Fatalf("write report: %v", err)
	}
	t.Logf("report=%s proxy_disconnects=%d rss_growth=%d heap_growth=%d", config.ReportPath, report.ProxyDisconnects, report.RSSGrowthBytes, report.HeapGrowthBytes)
	if report.Failure != "" || report.ProxyDisconnects != 0 || report.BackendUnexpectedErrors != 0 {
		t.Fatalf("soak failed: %#v", report)
	}
}

// oscillatingDialer stands in for a path manager whose active path is adopted
// again or replaced on a schedule, while every path reaches the same loopback
// echo backend.
type oscillatingDialer struct {
	endpoint string
	failures atomic.Uint64

	mu   sync.Mutex
	path pathmgr.Path
}

func newOscillatingDialer(endpoint string) *oscillatingDialer {
	return &oscillatingDialer{endpoint: endpoint, path: pathmgr.Path{
		DesktopID: "desktop-soak", Transport: transport.NameDirect, Kind: pathmgr.KindDirect, Address: "203.0.113.7:4740", Since: time.Now(),
	}}
}

func (dialer *oscillatingDialer) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	var direct net.Dialer
	return direct.DialContext(ctx, network, dialer.endpoint)
}

func (dialer *oscillatingDialer) Active() pathmgr.Path {
	dialer.mu.Lock()
	defer dialer.mu.Unlock()
	return dialer.path
}

func (dialer *oscillatingDialer) ReportFailure(error) { dialer.failures.Add(1) }

// readopt adopts the active path again with a later Since, as the manager
// does after re-dialing the endpoint of the active path.
func (dialer *oscillatingDialer) readopt() pathmgr.PathEvent {
	dialer.mu.Lock()
	defer dialer.mu.Unlock()
	dialer.path.Since = time.Now()
	return pathmgr.PathEvent{DesktopID: dialer.path.DesktopID, Transport: dialer.path.Transport, Path: dialer.path.Kind, Reason: pathmgr.ReasonNetworkChanged}
}

// flip replaces the active path by one of the other kind: the direct path
// becomes the reserve and the reserve becomes a direct path again.
func (dialer *oscillatingDialer) flip() pathmgr.PathEvent {
	dialer.mu.Lock()
	defer dialer.mu.Unlock()
	if dialer.path.Kind == pathmgr.KindTor {
		dialer.path = pathmgr.Path{DesktopID: dialer.path.DesktopID, Transport: transport.NameDirect, Kind: pathmgr.KindDirect, Address: "203.0.113.7:4740", Since: time.Now()}
		return pathmgr.PathEvent{DesktopID: dialer.path.DesktopID, Transport: transport.NameDirect, Path: pathmgr.KindDirect, Reason: pathmgr.ReasonUpgrade}
	}
	dialer.path = pathmgr.Path{DesktopID: dialer.path.DesktopID, Transport: transport.NameTor, Kind: pathmgr.KindTor, Since: time.Now()}
	return pathmgr.PathEvent{DesktopID: dialer.path.DesktopID, Transport: transport.NameTor, Path: pathmgr.KindTor, Reason: pathmgr.ReasonPathFailed}
}

type pathSoakReport struct {
	StartedAt                string `json:"startedAt"`
	FinishedAt               string `json:"finishedAt"`
	RequestedDuration        string `json:"requestedDuration"`
	ElapsedMillis            int64  `json:"elapsedMillis"`
	Sockets                  int    `json:"sockets"`
	PathInterval             string `json:"pathInterval"`
	MeasuredBursts           int    `json:"measuredBursts"`
	EquivalentAdopts         int    `json:"equivalentAdopts"`
	UpstreamsClosedOnAdopt   int    `json:"upstreamsClosedOnEquivalentAdopt"`
	SocketsSurvivedAdopt     int    `json:"socketsSurvivedEquivalentAdopt"`
	RealSwitches             int    `json:"realSwitches"`
	UpstreamsClosedOnSwitch  int    `json:"upstreamsClosedOnRealSwitch"`
	SocketsClosedOnSwitch    int    `json:"socketsClosedOnRealSwitch"`
	BackendAbruptDisconnects uint64 `json:"backendAbruptDisconnects"`
	PathFailuresReported     uint64 `json:"pathFailuresReported"`
	Failure                  string `json:"failure,omitempty"`
}

// awaitClosed reads every socket until the proxy ends it; a socket still open
// after timeout is a failure.
func awaitClosed(connections []*websocket.Conn, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for index, connection := range connections {
		if _, _, err := connection.Read(ctx); err == nil || errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("socket %d stayed open after the real switch: %v", index+1, err)
		}
	}
	return nil
}

// awaitCount waits until counter reaches want, for the backend goroutines to
// record the disconnects the proxy caused.
func awaitCount(counter *atomic.Uint64, want uint64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for counter.Load() < want {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// TestProxySoakOscillatingPath is CONN-13: the active path is adopted again
// and really switched in turns, every PathInterval. Sockets over an
// equivalent path survive and keep echoing, and only a real switch closes the
// upstreams, all of them, after which the page opens its sockets again.
func TestProxySoakOscillatingPath(t *testing.T) {
	config, err := ConfigFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	stats := &echoStats{}
	backend := httptest.NewServer(http.HandlerFunc(stats.handler))
	defer backend.Close()
	dialer := newOscillatingDialer(strings.TrimPrefix(backend.URL, "http://"))
	instance, err := proxy.New(proxy.Config{
		Dialer: dialer, DesktopID: "desktop-soak", DeviceToken: testDeviceToken(), ReadTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	opening, err := instance.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close(context.Background())
	setupContext, setupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	cookie, err := bootstrapCookie(setupContext, opening)
	if err != nil {
		setupCancel()
		t.Fatal(err)
	}
	connections, err := openSockets(setupContext, opening, cookie)
	setupCancel()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { closeSockets(connections) }()

	payload := bytes.Repeat([]byte{0xC2}, FrameBytes)
	report := pathSoakReport{
		StartedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		RequestedDuration: config.Duration.String(),
		Sockets:           SocketCount,
		PathInterval:      config.PathInterval.String(),
	}
	started := time.Now()
	deadline := started.Add(config.Duration)
	var expectedAbrupt uint64
	for cycle := 0; ; cycle++ {
		if _, err := runBurst(connections, payload); err != nil {
			report.Failure = fmt.Sprintf("burst %d: %v", report.MeasuredBursts+1, err)
			break
		}
		report.MeasuredBursts++
		if cycle > 0 && cycle%2 == 1 {
			// The burst just completed proves the sockets survived the
			// equivalent adopt before it.
			report.SocketsSurvivedAdopt += len(connections)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		time.Sleep(min(config.PathInterval, remaining))
		if cycle%2 == 0 {
			closed := instance.PathChanged(dialer.readopt())
			report.EquivalentAdopts++
			report.UpstreamsClosedOnAdopt += closed
			if closed != 0 {
				report.Failure = fmt.Sprintf("equivalent adopt %d closed %d upstreams", report.EquivalentAdopts, closed)
				break
			}
			if abrupt := stats.unexpectedErr.Load(); abrupt != expectedAbrupt {
				report.Failure = fmt.Sprintf("equivalent adopt %d disconnected %d backend sockets", report.EquivalentAdopts, abrupt-expectedAbrupt)
				break
			}
			continue
		}
		event := dialer.flip()
		closed := instance.PathChanged(event)
		report.RealSwitches++
		report.UpstreamsClosedOnSwitch += closed
		if closed != len(connections) {
			report.Failure = fmt.Sprintf("real switch %d to %s closed %d upstreams, want %d", report.RealSwitches, event.Path, closed, len(connections))
			break
		}
		if err := awaitClosed(connections, 10*time.Second); err != nil {
			report.Failure = err.Error()
			break
		}
		report.SocketsClosedOnSwitch += len(connections)
		expectedAbrupt += uint64(len(connections))
		if !awaitCount(&stats.unexpectedErr, expectedAbrupt, 10*time.Second) {
			report.Failure = fmt.Sprintf("backend saw %d abrupt disconnects after switch %d, want %d", stats.unexpectedErr.Load(), report.RealSwitches, expectedAbrupt)
			break
		}
		for _, connection := range connections {
			_ = connection.CloseNow()
		}
		reopenContext, reopenCancel := context.WithTimeout(context.Background(), 30*time.Second)
		connections, err = openSockets(reopenContext, opening, cookie)
		reopenCancel()
		if err != nil {
			report.Failure = fmt.Sprintf("reopen after switch %d: %v", report.RealSwitches, err)
			connections = nil
			break
		}
		t.Logf("switch=%d to %s closed=%d adopts=%d bursts=%d", report.RealSwitches, event.Path, closed, report.EquivalentAdopts, report.MeasuredBursts)
	}
	report.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	report.ElapsedMillis = time.Since(started).Milliseconds()
	report.BackendAbruptDisconnects = stats.unexpectedErr.Load()
	report.PathFailuresReported = dialer.failures.Load()
	if report.Failure == "" && report.BackendAbruptDisconnects != expectedAbrupt {
		report.Failure = fmt.Sprintf("backend saw %d abrupt disconnects, want %d from the real switches", report.BackendAbruptDisconnects, expectedAbrupt)
	}
	if report.Failure == "" && report.PathFailuresReported != 0 {
		report.Failure = fmt.Sprintf("proxy reported %d path failures", report.PathFailuresReported)
	}
	reportPath := strings.TrimSuffix(config.ReportPath, ".json") + "-oscillating.json"
	if err := writeReport(reportPath, report); err != nil {
		t.Fatalf("write report: %v", err)
	}
	t.Logf("report=%s bursts=%d equivalent_adopts=%d survived=%d real_switches=%d closed=%d", reportPath,
		report.MeasuredBursts, report.EquivalentAdopts, report.SocketsSurvivedAdopt, report.RealSwitches, report.UpstreamsClosedOnSwitch)
	if report.Failure != "" || report.EquivalentAdopts == 0 || report.RealSwitches == 0 {
		t.Fatalf("oscillating soak failed: %#v", report)
	}
}
