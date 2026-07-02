package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"

	"github.com/tanq16/kairo/internal/notes"
)

// writeServiceError maps service errors to HTTP statuses; raw details stay in server logs only
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

func decodeBase64Path(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		// Attempt URL-safe padded decoding
		decoded, err = base64.URLEncoding.DecodeString(encoded)
		if err != nil {
			// Attempt standard decoding
			decoded, err = base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return "", err
			}
		}
	}
	return string(decoded), nil
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
	pathParam := r.URL.Query().Get("path")
	decodedPath, err := decodeBase64Path(pathParam)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	content, err := s.service.GetFile(decodedPath)
	if err != nil {
		writeServiceError(w, "read file", err)
		return
	}

	ext := filepath.Ext(decodedPath)
	mimeType := mime.TypeByExtension(ext)
	if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}

	w.Write(content)
}

func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	var req notes.SaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	decodedPath, err := decodeBase64Path(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	if err := s.service.SaveFile(decodedPath, req.Content); err != nil {
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

	decodedPath, err := decodeBase64Path(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	finalPath, err := s.service.CreateFile(decodedPath, req.Content)
	if err != nil {
		writeServiceError(w, "create file", err)
		return
	}

	w.Write([]byte(finalPath))
}

func (s *Server) handleCreateDir(w http.ResponseWriter, r *http.Request) {
	var req notes.ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	decodedPath, err := decodeBase64Path(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	if err := s.service.CreateDir(decodedPath); err != nil {
		writeServiceError(w, "create directory", err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req notes.ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	decodedPath, err := decodeBase64Path(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	if err := s.service.Delete(decodedPath); err != nil {
		writeServiceError(w, "delete", err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	var req notes.ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	decodedOldPath, err := decodeBase64Path(req.Path)
	if err != nil {
		http.Error(w, "Invalid old path", http.StatusBadRequest)
		return
	}

	decodedNewPath, err := decodeBase64Path(req.NewPath)
	if err != nil {
		http.Error(w, "Invalid new path", http.StatusBadRequest)
		return
	}

	if err := s.service.Move(decodedOldPath, decodedNewPath); err != nil {
		writeServiceError(w, "move", err)
		return
	}

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
	decodedNotePath, err := decodeBase64Path(notePath)
	if err != nil {
		http.Error(w, "Invalid note path", http.StatusBadRequest)
		return
	}

	relPath, err := s.service.UploadFile(decodedNotePath, file, header.Filename)
	if err != nil {
		writeServiceError(w, "upload file", err)
		return
	}

	w.Write([]byte(relPath))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}
