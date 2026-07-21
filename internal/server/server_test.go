package server

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

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

func TestContentToken(t *testing.T) {
	// pinned SHA-256 vector for the empty input keeps determinism honest against a real value
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
	// set() seeds last so a matching changed() stays quiet — the autosave no-op guard
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
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
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
		}(i)
	}
	wg.Wait()
}

// newRunningHub starts the hub goroutine; every test's first interaction is a
// synchronous channel handoff, which proves run() is looping before shutdown().
func newRunningHub(t *testing.T) *hub {
	t.Helper()
	h := newHub()
	go h.run()
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

// mustRecv fails fast on a timeout so a missed broadcast never deadlocks the suite.
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

	// broadcast is unbuffered, so each emit returns only after run() has finished
	// fanning out the previous event; by the time emit("3") returns, the "2" fan-out
	// (which overflows slow's buffer and drops it) has already completed.
	h.emit(Event{Path: "1"}) // buffers into slow (now full) and healthy
	h.emit(Event{Path: "2"}) // slow full -> default case drops it
	h.emit(Event{Path: "3"}) // slow gone; healthy unaffected

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

	// emit() after shutdown selects the closed done channel: no panic, no block
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
					for range c.send { // ends when run() drops and closes the channel
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
