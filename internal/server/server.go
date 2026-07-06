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
}

func New(cfg Config) *Server {
	return &Server{
		config: cfg,
		mux:    http.NewServeMux(),
	}
}

func (s *Server) Setup() error {
	storage, err := notes.NewStorage(s.config.DataDir)
	if err != nil {
		return fmt.Errorf("failed to initialize storage: %w", err)
	}
	s.service = notes.NewService(storage)

	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return fmt.Errorf("failed to create static filesystem: %w", err)
	}
	s.mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	// API routes live on a sub-mux so the SPA catch-all can't shadow
	// method enforcement (405) or unknown-endpoint 404s under /api/
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/tree", s.handleTree)
	apiMux.HandleFunc("GET /api/file", s.handleFile)
	apiMux.HandleFunc("GET /api/search", s.handleSearch)
	apiMux.HandleFunc("POST /api/save", s.handleSave)
	apiMux.HandleFunc("POST /api/create-file", s.handleCreateFile)
	apiMux.HandleFunc("POST /api/create-dir", s.handleCreateDir)
	apiMux.HandleFunc("POST /api/delete", s.handleDelete)
	apiMux.HandleFunc("POST /api/move", s.handleMove)
	apiMux.HandleFunc("POST /api/upload", s.handleUpload)
	apiMux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.Handle("/api/", apiMux)

	s.mux.HandleFunc("/", s.handleIndex)

	return nil
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
