package server

import (
	"encoding/base64"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/tanq16/kairo/internal/notes"
)

func TestDecodeBase64Path(t *testing.T) {
	// "???" forces alphabet-distinguishing output ("Pz8_" raw-URL vs "Pz8/" std)
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"empty passthrough", "", "", false},
		{"raw URL", base64.RawURLEncoding.EncodeToString([]byte("???")), "???", false},
		{"padded URL", base64.URLEncoding.EncodeToString([]byte("a")), "a", false},
		{"standard", base64.StdEncoding.EncodeToString([]byte("???")), "???", false},
		{"plain path", base64.RawURLEncoding.EncodeToString([]byte("dir/note.md")), "dir/note.md", false},
		{"garbage", "!!!not-base64!!!", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decodeBase64Path(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("decodeBase64Path(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("decodeBase64Path(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestWriteServiceError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"invalid path", notes.ErrInvalidPath, http.StatusBadRequest},
		{"not found", os.ErrNotExist, http.StatusNotFound},
		// os.ReadFile surfaces misses as a *PathError, so the mapping must see through wrapping
		{"wrapped not found", &fs.PathError{Op: "open", Path: "x", Err: fs.ErrNotExist}, http.StatusNotFound},
		{"destination exists", notes.ErrExists, http.StatusConflict},
		{"unknown", errors.New("boom"), http.StatusInternalServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeServiceError(rec, "test", tt.err)
			if rec.Code != tt.want {
				t.Fatalf("writeServiceError(%v) status = %d, want %d", tt.err, rec.Code, tt.want)
			}
		})
	}
}
