package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/tanq16/kairo/internal/notes"
)

// Keep raw error detail in the server log; return only a generic, path-free message to the client
func writeServiceError(w http.ResponseWriter, action string, err error) {
	switch {
	case errors.Is(err, notes.ErrInvalidPath):
		http.Error(w, "Invalid path", http.StatusBadRequest)
	case errors.Is(err, os.ErrNotExist):
		http.Error(w, "Not found", http.StatusNotFound)
	case errors.Is(err, notes.ErrExists):
		http.Error(w, "Destination already exists", http.StatusConflict)
	default:
		log.Printf("ERROR Failed to %s: %v", action, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
	}
}

// sendBeacon (used on beforeunload) can't set headers, so it passes the client id as a query param instead of X-Kairo-Client
func clientID(r *http.Request) string {
	if id := r.Header.Get("X-Kairo-Client"); id != "" {
		return id
	}
	return r.URL.Query().Get("client")
}

// Paths crossed the wire base64-encoded before they became plain; only GET /api/file still reads that form, for URLs already shared or stored in a note
func legacyBase64Path(encoded string) (string, bool) {
	if encoded == "" {
		return "", false
	}
	for _, enc := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.StdEncoding} {
		decoded, err := enc.DecodeString(encoded)
		if err != nil {
			continue
		}
		// An ordinary extension-less note name is itself decodable, so a decode only counts when it yields something that could have named a file
		if utf8.Valid(decoded) && bytes.ContainsAny(decoded, "/.") {
			return string(decoded), true
		}
	}
	return "", false
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	root, err := s.service.GetTree()
	if err != nil {
		writeServiceError(w, "get tree", err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(root.Children)
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	notePath := r.URL.Query().Get("path")

	content, err := s.service.GetFile(notePath)
	if errors.Is(err, os.ErrNotExist) {
		if legacy, ok := legacyBase64Path(notePath); ok {
			if legacyContent, legacyErr := s.service.GetFile(legacy); legacyErr == nil {
				notePath, content, err = legacy, legacyContent, nil
			}
		}
	}
	if err != nil {
		writeServiceError(w, "read file", err)
		return
	}

	ext := filepath.Ext(notePath)
	mimeType := mime.TypeByExtension(ext)
	if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("X-Kairo-Version", contentToken(content))

	w.Write(content)
}

func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	var req notes.SaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// serialize write+token+emit so a reordered concurrent same-path save can't record a token for bytes it didn't write last
	s.saveMu.Lock()
	err := s.service.SaveFile(req.Path, req.Content)
	if err == nil {
		token := contentToken([]byte(req.Content))
		if s.tokens.changed(req.Path, token) {
			s.hub.emit(Event{Op: "save", Path: req.Path, Token: token, Origin: clientID(r)})
		}
	}
	s.saveMu.Unlock()
	if err != nil {
		writeServiceError(w, "save file", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleCreateFile(w http.ResponseWriter, r *http.Request) {
	// reuse SaveRequest: create needs the same {path, content} shape, unlike autosave it never overwrites
	var req notes.SaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	finalPath, err := s.service.CreateFile(req.Path, req.Content)
	if err != nil {
		writeServiceError(w, "create file", err)
		return
	}

	token := contentToken([]byte(req.Content))
	s.tokens.set(finalPath, token)
	s.hub.emit(Event{Op: "create", Path: finalPath, Token: token, Origin: clientID(r)})
	w.Write([]byte(finalPath))
}

func (s *Server) handleCreateDir(w http.ResponseWriter, r *http.Request) {
	var req notes.ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.service.CreateDir(req.Path); err != nil {
		writeServiceError(w, "create directory", err)
		return
	}

	s.hub.emit(Event{Op: "createDir", Path: req.Path, Origin: clientID(r)})
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req notes.ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.service.Delete(req.Path); err != nil {
		writeServiceError(w, "delete", err)
		return
	}

	s.tokens.dropTree(req.Path)
	s.hub.emit(Event{Op: "delete", Path: req.Path, Origin: clientID(r)})
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	var req notes.ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.service.Move(req.Path, req.NewPath); err != nil {
		writeServiceError(w, "move", err)
		return
	}

	// Move rewrites in-note attachment links, so the old token (and any descendant tokens for a moved directory) is stale — drop the tree rather than migrate it to the new path
	s.tokens.dropTree(req.Path)
	s.hub.emit(Event{Op: "move", Path: req.Path, NewPath: req.NewPath, Origin: clientID(r)})
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	// cap the whole request so oversized uploads fail instead of buffering unbounded input
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			http.Error(w, "File too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "Invalid multipart form", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	notePath := r.FormValue("notePath")
	relPath, err := s.service.UploadFile(notePath, file, header.Filename)
	if err != nil {
		writeServiceError(w, "upload file", err)
		return
	}

	s.hub.emit(Event{Op: "upload", Path: notePath, Origin: clientID(r)})
	w.Write([]byte(relPath))
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	results, err := s.service.Search(r.URL.Query().Get("q"))
	if err != nil {
		writeServiceError(w, "search", err)
		return
	}
	if results == nil {
		results = []notes.SearchResult{} // always emit a JSON array, never null
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

// Lets whatever wrote to the data directory announce it instead of waiting out the poll interval; deliberately outside requireWire, since the caller is a script or an agent with no client wire version to send
func (s *Server) handleRescan(w http.ResponseWriter, r *http.Request) {
	select {
	case s.rescan <- struct{}{}:
	default:
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}
