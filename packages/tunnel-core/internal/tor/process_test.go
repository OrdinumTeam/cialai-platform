// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"slices"
	"testing"
)

func TestWithLibraryDirPutsTheTorFolderFirst(t *testing.T) {
	const dir = "/usr/lib/Cialai/tor/tor"
	cases := []struct {
		name    string
		environ []string
		want    []string
	}{
		{"absent", []string{"HOME=/home/ana", "PATH=/usr/bin"}, []string{"HOME=/home/ana", "PATH=/usr/bin", "LD_LIBRARY_PATH=" + dir}},
		{"empty", []string{"LD_LIBRARY_PATH=", "HOME=/home/ana"}, []string{"HOME=/home/ana", "LD_LIBRARY_PATH=" + dir}},
		{"kept after", []string{"LD_LIBRARY_PATH=/opt/lib", "HOME=/home/ana"}, []string{"HOME=/home/ana", "LD_LIBRARY_PATH=" + dir + ":/opt/lib"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := withLibraryDir(test.environ, dir); !slices.Equal(got, test.want) {
				t.Fatalf("withLibraryDir = %q, want %q", got, test.want)
			}
		})
	}
}
