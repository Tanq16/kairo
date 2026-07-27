package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/tanq16/kairo/internal/notes"
)

func TestLegacyBase64Path(t *testing.T) {
	// "dir/note~1.md" encodes to "...dV+MS5tZA==" under the standard alphabet and "...dV-MS5tZA" under the URL one, so it tells the three decoders apart
	const alphabetProbe = "dir/note~1.md"
	tests := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{"empty is not a legacy path", "", "", false},
		{"raw URL", base64.RawURLEncoding.EncodeToString([]byte(alphabetProbe)), alphabetProbe, true},
		{"padded URL", base64.URLEncoding.EncodeToString([]byte(alphabetProbe)), alphabetProbe, true},
		{"standard", base64.StdEncoding.EncodeToString([]byte(alphabetProbe)), alphabetProbe, true},
		{"plain path", base64.RawURLEncoding.EncodeToString([]byte("dir/note.md")), "dir/note.md", true},
		{"garbage", "!!!not-base64!!!", "", false},
		// an extension-less note name is itself valid base64, and must not be mistaken for an encoded path
		{"decodes to a name that could not be a path", base64.RawURLEncoding.EncodeToString([]byte("notes")), "", false},
		{"decodes to binary junk", "Projects", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := legacyBase64Path(tt.in)
			if ok != tt.ok {
				t.Fatalf("legacyBase64Path(%q) ok = %v, want %v", tt.in, ok, tt.ok)
			}
			if got != tt.want {
				t.Fatalf("legacyBase64Path(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	s := New(Config{DataDir: t.TempDir()})
	if err := s.Setup(); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	t.Cleanup(s.hub.shutdown)
	return s
}

func saveNote(t *testing.T, s *Server, notePath, content string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(notes.SaveRequest{Path: notePath, Content: content})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/save", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kairo-Wire", wireVersion)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func TestAPIPathRoundTrip(t *testing.T) {
	// the wire carries plain paths now, so every character the query encoder touches has to survive the trip back
	paths := []string{
		"note.md",
		"dir/a b.md",
		"a+b.md",
		"50% off.md",
		"we#ird.md",
		"q?uery.md",
		"amp&equals=.md",
		"ünïcode ✅.md",
		"dir/sub/deep name.md",
	}
	for _, notePath := range paths {
		t.Run(notePath, func(t *testing.T) {
			s := newTestServer(t)
			content := "body of " + notePath
			if rec := saveNote(t, s, notePath, content); rec.Code != http.StatusOK {
				t.Fatalf("save %q status = %d, body %q", notePath, rec.Code, rec.Body)
			}

			req := httptest.NewRequest(http.MethodGet, "/api/file?path="+url.QueryEscape(notePath), nil)
			rec := httptest.NewRecorder()
			s.mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("read %q status = %d, body %q", notePath, rec.Code, rec.Body)
			}
			if rec.Body.String() != content {
				t.Fatalf("read %q = %q, want %q", notePath, rec.Body, content)
			}
		})
	}
}

func TestHandleFileLegacyBase64URL(t *testing.T) {
	// URLs the app handed out before paths went plain are still pasted and bookmarked
	s := newTestServer(t)
	if rec := saveNote(t, s, "dir/note.md", "legacy"); rec.Code != http.StatusOK {
		t.Fatalf("save status = %d", rec.Code)
	}

	encoded := base64.RawURLEncoding.EncodeToString([]byte("dir/note.md"))
	req := httptest.NewRequest(http.MethodGet, "/api/file?path="+encoded, nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "legacy" {
		t.Fatalf("legacy read = %d %q, want 200 %q", rec.Code, rec.Body, "legacy")
	}

	// a plain path that simply does not exist must stay a 404, not fall through to a decoded guess
	if rec := saveNote(t, s, "notes", "a note with no extension"); rec.Code != http.StatusOK {
		t.Fatalf("save status = %d", rec.Code)
	}
	for _, missing := range []string{"missing.md", base64.RawURLEncoding.EncodeToString([]byte("notes"))} {
		req := httptest.NewRequest(http.MethodGet, "/api/file?path="+url.QueryEscape(missing), nil)
		rec := httptest.NewRecorder()
		s.mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("missing path %q status = %d, want 404", missing, rec.Code)
		}
	}
}

func TestRequireWireRejectsStaleClient(t *testing.T) {
	// a pre-upgrade tab sends a base64 path, which is a legal filename and would otherwise be written verbatim
	s := newTestServer(t)
	stale := base64.RawURLEncoding.EncodeToString([]byte("note.md"))
	body, err := json.Marshal(notes.SaveRequest{Path: stale, Content: "edit from a stale tab"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, tt := range []struct {
		name string
		url  string
		hdr  string
		want int
	}{
		{"no marker", "/api/save", "", http.StatusBadRequest},
		{"wrong marker", "/api/save", "1", http.StatusBadRequest},
		{"header marker", "/api/save", wireVersion, http.StatusOK},
		{"beacon query marker", "/api/save?wire=" + wireVersion, "", http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tt.url, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			if tt.hdr != "" {
				req.Header.Set("X-Kairo-Wire", tt.hdr)
			}
			rec := httptest.NewRecorder()
			s.mux.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
		})
	}

	// reads are never gated: a stale tab must still be able to load what it is showing
	req := httptest.NewRequest(http.MethodGet, "/api/tree", nil)
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/tree status = %d, want 200", rec.Code)
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

func TestContentToken(t *testing.T) {
	const emptySHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := contentToken(nil); got != emptySHA {
		t.Fatalf("contentToken(nil) = %q, want %q", got, emptySHA)
	}
	if contentToken(nil) != contentToken([]byte{}) {
		t.Fatal("nil and an empty slice must share a token")
	}
	a1, a2 := contentToken([]byte("hello")), contentToken([]byte("hello"))
	if a1 != a2 {
		t.Fatalf("non-deterministic for identical bytes: %q vs %q", a1, a2)
	}
	for _, other := range []string{"world", "hellO", "hello ", "Hello"} {
		if a1 == contentToken([]byte(other)) {
			t.Fatalf("token collision between %q and %q", "hello", other)
		}
	}
}

func TestTokenTableChanged(t *testing.T) {
	tt := newTokenTable()
	tokA := contentToken([]byte("A"))
	tokB := contentToken([]byte("B"))

	if !tt.changed("p", tokA) {
		t.Fatal("first token for a path must report changed")
	}
	if tt.changed("p", tokA) {
		t.Fatal("re-seeing the same token must report unchanged")
	}
	if !tt.changed("p", tokB) {
		t.Fatal("a new token must report changed")
	}
	if tt.changed("p", tokB) {
		t.Fatal("the new token must be recorded so a repeat is unchanged")
	}
	if !tt.changed("q", tokB) {
		t.Fatal("first token for an independent path must report changed")
	}
	tt.drop("p")
	if !tt.changed("p", tokB) {
		t.Fatal("changed() after drop() must report changed again")
	}
	tt.set("r", tokA)
	if tt.changed("r", tokA) {
		t.Fatal("changed() matching a seeded token must report unchanged")
	}
	if !tt.changed("r", tokB) {
		t.Fatal("changed() differing from a seeded token must report changed")
	}
}

func TestTokenTableConcurrent(t *testing.T) {
	tt := newTokenTable()
	paths := []string{"a", "b", "c", "d"}
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Go(func() {
			p := paths[i%len(paths)]
			for j := range 200 {
				switch j % 3 {
				case 0:
					tt.changed(p, contentToken([]byte{byte(j)}))
				case 1:
					tt.set(p, contentToken([]byte{byte(i)}))
				default:
					tt.drop(p)
				}
			}
		})
	}
	wg.Wait()
}

func TestTokenTableDropTree(t *testing.T) {
	// the "/" boundary is the crux: prefix "notes" must reach "notes/a.md" yet never the sibling "notesX.md"
	tests := []struct {
		name    string
		seed    []string
		prefix  string
		dropped []string
		kept    []string
	}{
		{
			name:    "directory drops exact key and descendants",
			seed:    []string{"notes", "notes/a.md", "notes/sub/b.md", "notesX.md", "other/c.md"},
			prefix:  "notes",
			dropped: []string{"notes", "notes/a.md", "notes/sub/b.md"},
			kept:    []string{"notesX.md", "other/c.md"},
		},
		{
			name:    "plain file behaves like drop",
			seed:    []string{"notes/a.md", "notes/a.md.bak"},
			prefix:  "notes/a.md",
			dropped: []string{"notes/a.md"},
			kept:    []string{"notes/a.md.bak"},
		},
		{
			name:   "absent prefix leaves table intact",
			seed:   []string{"a.md", "b/c.md"},
			prefix: "missing",
			kept:   []string{"a.md", "b/c.md"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			table := newTokenTable()
			for _, p := range tt.seed {
				table.set(p, contentToken([]byte(p)))
			}
			table.dropTree(tt.prefix)
			// a dropped key is gone, so re-seeing its token reports changed; a kept key still matches, so it reports unchanged
			for _, p := range tt.dropped {
				if !table.changed(p, contentToken([]byte(p))) {
					t.Fatalf("%q should have been dropped but is still present", p)
				}
			}
			for _, p := range tt.kept {
				if table.changed(p, contentToken([]byte(p))) {
					t.Fatalf("%q should have been kept but was dropped", p)
				}
			}
		})
	}
}

func newRunningHub(t *testing.T) *hub {
	t.Helper()
	h := newHub()
	// start via wg.Go like production so shutdown()'s wg.Wait() actually blocks on run() draining
	h.wg.Go(h.run)
	return h
}

func registerClient(t *testing.T, h *hub, buffer int) *client {
	t.Helper()
	c := &client{send: make(chan Event, buffer)}
	select {
	case h.register <- c:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out registering client")
	}
	return c
}

func unregisterClient(t *testing.T, h *hub, c *client) {
	t.Helper()
	select {
	case h.unregister <- c:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out unregistering client")
	}
}

func mustRecv(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("send channel closed while awaiting an event")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out awaiting an event")
		return Event{}
	}
}

func TestHubFanOut(t *testing.T) {
	for _, n := range []int{1, 2, 8} {
		t.Run(fmt.Sprintf("clients=%d", n), func(t *testing.T) {
			h := newRunningHub(t)
			defer h.shutdown()

			clients := make([]*client, n)
			for i := range clients {
				clients[i] = registerClient(t, h, 4)
			}
			ev := Event{Op: "update", Path: "notes/a.md"}
			h.emit(ev)
			for i, c := range clients {
				if got := mustRecv(t, c.send); got != ev {
					t.Fatalf("client %d got %+v, want %+v", i, got, ev)
				}
			}
		})
	}
}

func TestHubEventRoundTrip(t *testing.T) {
	h := newRunningHub(t)
	defer h.shutdown()

	c := registerClient(t, h, 1)
	ev := Event{Op: "move", Path: "a/b.md", NewPath: "a/c.md", Token: "tok123", Origin: "client-xyz"}
	h.emit(ev)
	if got := mustRecv(t, c.send); got != ev {
		t.Fatalf("round-trip = %+v, want %+v", got, ev)
	}
}

func TestHubDropsSlowClient(t *testing.T) {
	h := newRunningHub(t)
	defer h.shutdown()

	healthy := registerClient(t, h, 16)
	slow := registerClient(t, h, 1)

	// broadcast is unbuffered, so each emit returns only after run() finished the prior fan-out; by the time emit("3") returns, "2" has already overflowed and dropped slow
	h.emit(Event{Path: "1"})
	h.emit(Event{Path: "2"})
	h.emit(Event{Path: "3"})

	for _, want := range []string{"1", "2", "3"} {
		if got := mustRecv(t, healthy.send); got.Path != want {
			t.Fatalf("healthy got path %q, want %q", got.Path, want)
		}
	}

	if got, ok := <-slow.send; !ok || got.Path != "1" {
		t.Fatalf("slow first recv = (%+v, %v), want (path 1, true)", got, ok)
	}
	if _, ok := <-slow.send; ok {
		t.Fatal("slow client channel must be closed after being dropped")
	}
}

func TestHubUnregister(t *testing.T) {
	h := newRunningHub(t)
	defer h.shutdown()

	c1 := registerClient(t, h, 4)
	c2 := registerClient(t, h, 4)

	unregisterClient(t, h, c1)

	ev := Event{Op: "update", Path: "x.md"}
	h.emit(ev)

	if got := mustRecv(t, c2.send); got != ev {
		t.Fatalf("surviving client got %+v, want %+v", got, ev)
	}
	select {
	case got, ok := <-c1.send:
		if ok {
			t.Fatalf("unregistered client received %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("unregistered client channel was not closed")
	}
}

func TestHubShutdown(t *testing.T) {
	h := newRunningHub(t)
	c := registerClient(t, h, 4)

	h.shutdown()

	select {
	case _, ok := <-c.send:
		if ok {
			t.Fatal("shutdown must close client send channels")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("client channel not closed by shutdown")
	}

	done := make(chan struct{})
	go func() {
		h.emit(Event{Path: "after-shutdown"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("emit blocked after shutdown")
	}
}

func TestHubConcurrent(t *testing.T) {
	h := newRunningHub(t)
	defer h.shutdown()

	const workers = 8
	var wg sync.WaitGroup

	for i := range workers {
		wg.Go(func() {
			for range 100 {
				h.emit(Event{Op: "update", Path: fmt.Sprintf("p-%d", i)})
			}
		})
	}

	for range workers {
		wg.Go(func() {
			for range 50 {
				c := &client{send: make(chan Event, 4)}
				select {
				case h.register <- c:
				case <-h.done:
					return
				}
				drained := make(chan struct{})
				go func() {
					for range c.send {
					}
					close(drained)
				}()
				select {
				case h.unregister <- c:
				case <-h.done:
				}
				<-drained
			}
		})
	}

	wg.Wait()
}
