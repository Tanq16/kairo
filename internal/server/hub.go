package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Event is an advisory, path-only change notification fanned out to SSE clients. It
// never carries note content; a client re-fetches through the file/tree APIs.
type Event struct {
	Op      string `json:"op"`
	Path    string `json:"path"`
	NewPath string `json:"newPath,omitempty"`
	Token   string `json:"token,omitempty"`
	Origin  string `json:"origin,omitempty"`
}

type client struct {
	send chan Event
}

// hub is a single-goroutine pub/sub: only run() reads or writes clients and only run()
// ever closes a send channel, which keeps the fan-out lock-free and panic-free.
type hub struct {
	register   chan *client
	unregister chan *client
	broadcast  chan Event
	clients    map[*client]bool
	done       chan struct{}
	wg         sync.WaitGroup
}

func newHub() *hub {
	return &hub{
		register:   make(chan *client),
		unregister: make(chan *client),
		broadcast:  make(chan Event),
		clients:    make(map[*client]bool),
		done:       make(chan struct{}),
	}
}

func (h *hub) run() {
	for {
		select {
		case c := <-h.register:
			h.clients[c] = true
		case c := <-h.unregister:
			h.drop(c)
		case ev := <-h.broadcast:
			for c := range h.clients {
				select {
				case c.send <- ev:
				default:
					h.drop(c) // a client that can't keep up is dropped, never blocks the hub
				}
			}
		case <-h.done:
			for c := range h.clients {
				h.drop(c)
			}
			return
		}
	}
}

// drop is only ever called from run(); the membership check makes a repeat drop a
// no-op so a slow-client drop followed by the handler's unregister can't double-close.
func (h *hub) drop(c *client) {
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
}

// emit blocks only until run() takes the event (run itself never blocks) or the hub
// shuts down, so a mutation handler is never stalled and broadcast is never closed.
func (h *hub) emit(ev Event) {
	select {
	case h.broadcast <- ev:
	case <-h.done:
	}
}

func (h *hub) shutdown() {
	close(h.done)
	h.wg.Wait()
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // stop nginx from buffering the stream shut
	if err := rc.Flush(); err != nil {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}
	fmt.Fprint(w, "retry: 3000\n\n")
	rc.Flush()

	c := &client{send: make(chan Event, 16)}
	select {
	case s.hub.register <- c:
	case <-s.hub.done:
		return
	}
	defer func() {
		// a shut-down hub has already stopped reading unregister, so guard on done or block forever
		select {
		case s.hub.unregister <- c:
		case <-s.hub.done:
		}
	}()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-c.send:
			if !ok {
				return // hub closed us: shutdown or slow-client drop
			}
			data, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		}
	}
}
