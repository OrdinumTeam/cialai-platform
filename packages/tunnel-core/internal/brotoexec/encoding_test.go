package brotoexec

import (
	"bytes"
	"testing"
	"unicode/utf8"
)

func TestBoundedSummaryDoesNotSplitUTF8(t *testing.T) {
	for _, text := range []string{"ação café", "漢字", "🙂"} {
		for limit := 1; limit < len(text); limit++ {
			b := &bounded{limit: limit}
			for _, v := range []byte(text) {
				b.Write([]byte{v})
			}
			if !utf8.ValidString(b.String()) {
				t.Errorf("invalid UTF8 with limit %d for %q", limit, text)
			}
		}
	}
}
func TestStreamOutputPreservesFragmentedUTF8(t *testing.T) {
	text := bytes.Repeat([]byte("ação 漢字 🙂"), 12000)
	var output bytes.Buffer
	w := streamWriter{emit: func(p []byte) {
		if len(p) > 64<<10 {
			t.Fatal("oversized output chunk")
		}
		output.Write(p)
	}}
	for start := 0; start < len(text); {
		end := start + 65537
		if end > len(text) {
			end = len(text)
		}
		w.Write(text[start:end])
		start = end
	}
	if !bytes.Equal(output.Bytes(), text) {
		t.Fatal("UTF8 bytes lost across stream chunks")
	}
}
