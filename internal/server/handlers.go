package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"

	"github.com/tanq16/kairo/internal/notes"
)

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
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "File too large", http.StatusBadRequest)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// We return the Base64-encoded relative path now? Actually, let's keep relPath as is.
	// We might need to encode it to base64 if the frontend expects it, or frontend can encode it.
	// Since we are changing all API paths to Base64, frontend will encode/decode paths.
	// But `relPath` returned from here is inserted into markdown `![Attachment](relPath)`.
	// Markdown paths should NOT be base64. They should be relative text.
	// The problem statement says: "I want to implement GitHub like storage where all notes are valid markdown files, and any embedded images or linked images are referenced via relative paths inside markdown and base64. Also need frontend and backend synchronization to support paths properly."
	// Wait, the prompt says: "I want to implement GitHub like storage where all notes are valid markdown files, and any embedded images or linked images are referenced via relative paths inside markdown and base64."
	// Let's think: The path inside markdown should just be a normal relative path (`attachments/image.png`).
	// When requested, the frontend fetches the image using base64.
	// Wait, "referenced via relative paths inside markdown and base64. Also need frontend and backend synchronization to support paths properly."
	// Ah, I see: it should be referenced via relative paths *inside markdown*, but the frontend might request it via base64 encoding from the server.

	// Yes, `relPath` should be a relative path. We will encode it in frontend when fetching.
	w.Write([]byte(relPath))
}
