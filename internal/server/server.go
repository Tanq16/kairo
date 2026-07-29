package server

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/tanq16/kairo/internal/notes"
)

//go:embed static
var staticFiles embed.FS

type Config struct {
	Port    int
	Host    string
	DataDir string
}

type Server struct {
	config  Config
	mux     *http.ServeMux
	service *notes.Service
	hub     *hub
	tokens  *tokenTable
	saveMu  sync.Mutex
	rescan  chan struct{}
}

func New(cfg Config) *Server {
	return &Server{
		config: cfg,
		mux:    http.NewServeMux(),
		hub:    newHub(),
		tokens: newTokenTable(),
		rescan: make(chan struct{}, 1),
	}
}

// Every server route hides behind one unguessable segment so that no note path can ever shadow one; a compile-time constant rather than a per-process value so bookmarks, caches and rolling restarts survive
const routePrefix = "/_kairo-21b89d9a-af98-4aae-b036-4c9a08a216aa"

func (s *Server) Setup() error {
	storage, err := notes.NewStorage(s.config.DataDir)
	if err != nil {
		return fmt.Errorf("failed to initialize storage: %w", err)
	}
	s.service = notes.NewService(storage)
	s.hub.wg.Go(s.hub.run)
	s.hub.wg.Go(s.watch)

	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return fmt.Errorf("failed to create static filesystem: %w", err)
	}
	s.mux.Handle(routePrefix+"/static/", http.StripPrefix(routePrefix+"/static/", http.FileServer(http.FS(staticFS))))

	// API routes live on a sub-mux so the SPA catch-all can't shadow method enforcement (405) or unknown-endpoint 404s under the API subtree
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/tree", s.handleTree)
	apiMux.HandleFunc("GET /api/file", s.handleFile)
	apiMux.HandleFunc("GET /api/search", s.handleSearch)
	apiMux.HandleFunc("POST /api/save", requireWire(s.handleSave))
	apiMux.HandleFunc("POST /api/create-file", requireWire(s.handleCreateFile))
	apiMux.HandleFunc("POST /api/create-dir", requireWire(s.handleCreateDir))
	apiMux.HandleFunc("POST /api/delete", requireWire(s.handleDelete))
	apiMux.HandleFunc("POST /api/move", requireWire(s.handleMove))
	apiMux.HandleFunc("POST /api/upload", requireWire(s.handleUpload))
	apiMux.HandleFunc("POST /api/rescan", s.handleRescan)
	apiMux.HandleFunc("GET /api/events", s.handleEvents)
	apiMux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.Handle(routePrefix+"/api/", http.StripPrefix(routePrefix, apiMux))

	// A tab left open across the upgrade still posts to the old unprefixed endpoints; without these it would read the SPA shell as a 200 and drop the edit it was holding
	for _, pattern := range []string{"POST /api/save", "POST /api/create-file", "POST /api/create-dir", "POST /api/delete", "POST /api/move", "POST /api/upload"} {
		s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "Outdated client, please reload the page", http.StatusBadRequest)
		})
	}

	s.mux.HandleFunc("/", s.handleIndex)

	return nil
}

const wireVersion = "2"

// A tab still running the pre-plain-path client sends base64, which is itself a legal filename and would be written verbatim to a junk path; refusing the write turns silent corruption into the save failure the client already knows how to surface
func requireWire(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// sendBeacon can't set headers, so the marker rides as a query param there
		if r.Header.Get("X-Kairo-Wire") != wireVersion && r.URL.Query().Get("wire") != wireVersion {
			http.Error(w, "Outdated client, please reload the page", http.StatusBadRequest)
			return
		}
		next(w, r)
	}
}

func (s *Server) Run() error {
	addr := fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)
	// ReadTimeout/WriteTimeout stay unset so large uploads and downloads on slow links survive
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("INFO Starting on http://%s", addr)
		log.Printf("INFO Data directory: %s", s.config.DataDir)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		log.Printf("INFO Shutting down")
		// close SSE streams first — a live stream never idles and would otherwise pin srv.Shutdown to its full timeout
		s.hub.shutdown()
		return srv.Shutdown(shutdownCtx)
	}
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	data, err := staticFiles.ReadFile("static/index.html")
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html")
	w.Write(data)
}
