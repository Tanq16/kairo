package server

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"

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
	// Initialize storage and service
	storage, err := notes.NewStorage(s.config.DataDir)
	if err != nil {
		return fmt.Errorf("failed to initialize storage: %w", err)
	}
	s.service = notes.NewService(storage)

	// Serve embedded static files
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return fmt.Errorf("failed to create static filesystem: %w", err)
	}
	s.mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	// Serve data directory (for attachments/images)
	s.mux.Handle("/data/", http.StripPrefix("/data/", http.FileServer(http.Dir(s.config.DataDir))))

	// API routes
	s.mux.HandleFunc("/api/tree", s.handleTree)
	s.mux.HandleFunc("/api/file", s.handleFile)
	s.mux.HandleFunc("/api/save", s.handleSave)
	s.mux.HandleFunc("/api/create-dir", s.handleCreateDir)
	s.mux.HandleFunc("/api/delete", s.handleDelete)
	s.mux.HandleFunc("/api/move", s.handleMove)
	s.mux.HandleFunc("/api/upload", s.handleUpload)

	// Serve index.html at root
	s.mux.HandleFunc("/", s.handleIndex)

	return nil
}

func (s *Server) Run() error {
	addr := fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)
	log.Printf("INFO [server] Starting on http://%s", addr)
	log.Printf("INFO [server] Data directory: %s", s.config.DataDir)
	return http.ListenAndServe(addr, s.mux)
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
