// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRenderTorrcServiceProfile(t *testing.T) {
	dir := t.TempDir()
	options := torrcOptions{
		role:            roleService,
		dataDir:         filepath.Join(dir, `data "quoted" \ dir`),
		controlPortFile: filepath.Join(dir, "control-port"),
		cookieFile:      filepath.Join(dir, "cookie"),
		ownerPID:        4242,
	}
	contents, err := renderTorrc(options)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(contents)), "\n")
	for _, want := range []string{
		"DisableNetwork 1",
		"ControlPort auto",
		"CookieAuthentication 1",
		"__OwningControllerProcess 4242",
		"SocksPort 0",
		"HiddenServiceNonAnonymousMode 1",
		"HiddenServiceSingleHopMode 1",
		`DataDirectory "` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(options.dataDir) + `"`,
		`ControlPortWriteToFile "` + options.controlPortFile + `"`,
		`CookieAuthFile "` + options.cookieFile + `"`,
	} {
		if !slices.Contains(lines, want) {
			t.Errorf("torrc lacks %q:\n%s", want, contents)
		}
	}
	if strings.Contains(string(contents), "GeoIP") {
		t.Error("torrc names GeoIP files that were not given")
	}
	// The fake tor reads the file back the way Tor unquotes it.
	path := filepath.Join(dir, "torrc")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := readFakeTorrc([]string{"-f", path})
	if err != nil || values["DataDirectory"] != options.dataDir {
		t.Fatalf("round trip DataDirectory = %q, err %v", values["DataDirectory"], err)
	}
}

func TestRenderTorrcClientProfileAndGeoIP(t *testing.T) {
	dir := t.TempDir()
	contents, err := renderTorrc(torrcOptions{
		role:            roleClient,
		dataDir:         filepath.Join(dir, "data"),
		controlPortFile: filepath.Join(dir, "port"),
		cookieFile:      filepath.Join(dir, "cookie"),
		ownerPID:        1,
		geoIP:           filepath.Join(dir, "geoip"),
		geoIPv6:         filepath.Join(dir, "geoip6"),
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	if !strings.Contains(text, "SocksPort auto\n") || strings.Contains(text, "HiddenService") {
		t.Fatalf("client profile:\n%s", text)
	}
	if !strings.Contains(text, `GeoIPFile "`+filepath.Join(dir, "geoip")+`"`) || !strings.Contains(text, "GeoIPv6File ") {
		t.Fatalf("GeoIP lines missing:\n%s", text)
	}
}

func TestRenderTorrcRejectsUnsafeValues(t *testing.T) {
	dir := t.TempDir()
	valid := torrcOptions{
		role:            roleService,
		dataDir:         filepath.Join(dir, "data"),
		controlPortFile: filepath.Join(dir, "port"),
		cookieFile:      filepath.Join(dir, "cookie"),
		ownerPID:        1,
	}
	cases := map[string]func(*torrcOptions){
		"newline smuggles a line": func(options *torrcOptions) { options.dataDir += "\nSocksPort 9050" },
		"relative path":           func(options *torrcOptions) { options.cookieFile = "cookie" },
		"missing control file":    func(options *torrcOptions) { options.controlPortFile = "" },
		"missing owner":           func(options *torrcOptions) { options.ownerPID = 0 },
		"unknown role":            func(options *torrcOptions) { options.role = torRole(9) },
	}
	for name, mutate := range cases {
		options := valid
		mutate(&options)
		if _, err := renderTorrc(options); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestBundleGeoIP(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "tor", "tor")
	if geoIP, geoIPv6 := bundleGeoIP(executable); geoIP != "" || geoIPv6 != "" {
		t.Fatalf("missing files reported as %q %q", geoIP, geoIPv6)
	}
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data", "geoip"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	geoIP, geoIPv6 := bundleGeoIP(executable)
	if geoIP != filepath.Join(root, "data", "geoip") || geoIPv6 != "" {
		t.Fatalf("bundleGeoIP = %q %q", geoIP, geoIPv6)
	}
}
