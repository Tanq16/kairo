package server

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/tanq16/kairo/internal/notes"
)

// httptest.NewRequest parses a raw request line and panics on a space, so a note URL has to arrive escaped exactly as a browser would send it
func noteURL(notePath string) string {
	segments := strings.Split(notePath, "/")
	for i, seg := range segments {
		segments[i] = url.PathEscape(seg)
	}
	return "/" + strings.Join(segments, "/")
}

func TestRouteNamesAreOrdinaryNotes(t *testing.T) {
	// "api" and "static" used to be server routes, so a note under either opened from the file tree but never from its own URL
	for _, notePath := range []string{"api/spec.md", "static/thing.md", "api", "static", "static/js/app.js", "docs/my note.md"} {
		t.Run(notePath, func(t *testing.T) {
			s := newTestServer(t)
			content := "body of " + notePath
			if rec := saveNote(t, s, notePath, content); rec.Code != http.StatusOK {
				t.Fatalf("save %q status = %d, body %q", notePath, rec.Code, rec.Body)
			}

			req := httptest.NewRequest(http.MethodGet, routePrefix+"/api/file?path="+url.QueryEscape(notePath), nil)
			rec := httptest.NewRecorder()
			s.mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK || rec.Body.String() != content {
				t.Fatalf("read %q = %d %q, want 200 %q", notePath, rec.Code, rec.Body, content)
			}

			req = httptest.NewRequest(http.MethodGet, noteURL(notePath), nil)
			rec = httptest.NewRecorder()
			s.mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s status = %d, want the SPA shell", noteURL(notePath), rec.Code)
			}
			if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
				t.Fatalf("GET %s Content-Type = %q, want text/html", noteURL(notePath), ct)
			}
			if !strings.Contains(rec.Body.String(), "<title>") {
				t.Fatalf("GET %s did not return the SPA shell", noteURL(notePath))
			}
		})
	}
}

func TestOldClientWriteIsRefused(t *testing.T) {
	// a tab left open across the upgrade still posts to the old endpoints; answering with the SPA shell would read as a 200 and the client would drop the edit it is holding
	s := newTestServer(t)
	body, err := json.Marshal(notes.SaveRequest{Path: "note.md", Content: "edit from a pre-upgrade tab"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, p := range []string{"/api/save", "/api/create-file", "/api/create-dir", "/api/delete", "/api/move", "/api/upload"} {
		req := httptest.NewRequest(http.MethodPost, p, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		// even a current wire marker has to fail here: the endpoint itself moved
		req.Header.Set("X-Kairo-Wire", wireVersion)
		rec := httptest.NewRecorder()
		s.mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST %s = %d, want 400", p, rec.Code)
		}
	}

	// the refusal is method-scoped, so a note named after one of those routes still reads back through its own URL
	if rec := saveNote(t, s, "api/save", "a note named after a route"); rec.Code != http.StatusOK {
		t.Fatalf("save api/save status = %d, body %q", rec.Code, rec.Body)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/save", nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<title>") {
		t.Fatalf("GET /api/save = %d, want the SPA shell", rec.Code)
	}
}

func TestClientUsesRoutePrefix(t *testing.T) {
	// the prefix is a hand-typed literal in Go, in index.html and in app.js, and no Go test executes the client, so a half-done rename is otherwise silent and total
	shell, err := fs.ReadFile(staticFiles, "static/index.html")
	if err != nil {
		t.Fatalf("read shell: %v", err)
	}
	for _, m := range regexp.MustCompile(`(?:src|href)="(/[^"]*)"`).FindAllStringSubmatch(string(shell), -1) {
		if !strings.HasPrefix(m[1], routePrefix+"/") {
			t.Fatalf("index.html asset %q is not under %q", m[1], routePrefix)
		}
	}

	appJS, err := fs.ReadFile(staticFiles, "static/js/app.js")
	if err != nil {
		t.Fatalf("read app.js: %v", err)
	}
	if want := "const KAIRO_ROUTES = '" + routePrefix + "';"; !strings.Contains(string(appJS), want) {
		t.Fatalf("app.js does not declare %s", want)
	}

	// only the hand-written files: the vendored bundles carry unrelated /api/ substrings, and css/ and fonts/ are gitignored so they are absent in CI
	for _, name := range []string{"links", "render", "print", "editor", "app", "sync"} {
		data, err := fs.ReadFile(staticFiles, "static/js/"+name+".js")
		if err != nil {
			t.Fatalf("read %s.js: %v", name, err)
		}
		for _, bare := range []string{`"/api/`, `'/api/`, "`/api/", `"/static/`, `'/static/`, "`/static/"} {
			if strings.Contains(string(data), bare) {
				t.Fatalf("%s.js builds a URL from %s, which is now an ordinary note path", name, bare)
			}
		}
	}
}
