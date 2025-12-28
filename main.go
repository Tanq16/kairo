package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed frontend/*
var frontendFS embed.FS

// Global configuration
var (
	dataDir string
	port    string
)

type FileNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"` // Relative path
	IsDir    bool        `json:"isDir"`
	Children []*FileNode `json:"children,omitempty"`
}

type SaveRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type ActionRequest struct {
	Path    string `json:"path"`
	NewPath string `json:"newPath,omitempty"` // For moves
}

func main() {
	flag.StringVar(&dataDir, "data", "./data", "Path to the data directory")
	flag.StringVar(&port, "port", "8080", "Port to run the server on")
	flag.Parse()

	// Ensure data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	// Ensure .trash directory exists
	trashDir := filepath.Join(dataDir, ".trash")
	if err := os.MkdirAll(trashDir, 0755); err != nil {
		log.Printf("Warning: Failed to create .trash directory: %v", err)
	}

	http.Handle("/", http.FileServer(http.FS(mustSub(frontendFS, "frontend"))))
	http.HandleFunc("/api/tree", handleTree)
	http.HandleFunc("/api/file", handleFile)
	http.HandleFunc("/api/save", handleSave)
	http.HandleFunc("/api/delete", handleDelete)
	http.HandleFunc("/api/move", handleMove)
	http.HandleFunc("/api/upload", handleUpload)

	log.Printf("Kairō is running on http://localhost:%s using data dir: %s", port, dataDir)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func mustSub(f embed.FS, path string) fs.FS {
	sub, err := fs.Sub(f, path)
	if err != nil {
		panic(err)
	}
	return sub
}

// Security: Prevent path traversal
func safePath(reqPath string) (string, error) {
	clean := filepath.Clean(reqPath)
	if strings.Contains(clean, "..") || strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, "\\") {
		return "", fmt.Errorf("invalid path")
	}
	return filepath.Join(dataDir, clean), nil
}

func handleTree(w http.ResponseWriter, r *http.Request) {
	root := &FileNode{
		Name:     "root",
		Path:     "",
		IsDir:    true,
		Children: []*FileNode{},
	}

	err := filepath.WalkDir(dataDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		relPath, _ := filepath.Rel(dataDir, path)
		if relPath == "." {
			return nil
		}

		// Skip hidden files/folders and .trash
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		parts := strings.Split(relPath, string(os.PathSeparator))
		current := root

		// Navigate to the correct parent node
		for i := 0; i < len(parts)-1; i++ {
			part := parts[i]
			found := false
			for _, child := range current.Children {
				if child.Name == part && child.IsDir {
					current = child
					found = true
					break
				}
			}
			if !found {
				// Should not happen if WalkDir visits parents first, but handle just in case
				newNode := &FileNode{Name: part, Path: filepath.Join(parts[:i+1]...), IsDir: true, Children: []*FileNode{}}
				current.Children = append(current.Children, newNode)
				current = newNode
			}
		}

		// Add the node
		node := &FileNode{
			Name:  d.Name(),
			Path:  relPath,
			IsDir: d.IsDir(),
		}
		if d.IsDir() {
			node.Children = []*FileNode{}
		}
		current.Children = append(current.Children, node)

		return nil
	})

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Sort children: Directories first, then files
	sortTree(root)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(root.Children)
}

func sortTree(node *FileNode) {
	sort.Slice(node.Children, func(i, j int) bool {
		if node.Children[i].IsDir != node.Children[j].IsDir {
			return node.Children[i].IsDir
		}
		return strings.ToLower(node.Children[i].Name) < strings.ToLower(node.Children[j].Name)
	})
	for _, child := range node.Children {
		if child.IsDir {
			sortTree(child)
		}
	}
}

func handleFile(w http.ResponseWriter, r *http.Request) {
	pathParam := r.URL.Query().Get("path")
	fullPath, err := safePath(pathParam)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	content, err := os.ReadFile(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Write(content)
}

var mu sync.Mutex

func handleSave(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	var req SaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fullPath, err := safePath(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Ensure directory exists
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "Could not create directory", http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(fullPath, []byte(req.Content), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func handleDelete(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	var req ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fullPath, err := safePath(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Move to .trash
	trashDir := filepath.Join(dataDir, ".trash")
	timestamp := time.Now().Format("20060102_150405")
	baseName := filepath.Base(fullPath)
	trashPath := filepath.Join(trashDir, fmt.Sprintf("%s_%s", timestamp, baseName))

	if err := os.Rename(fullPath, trashPath); err != nil {
		http.Error(w, "Failed to move to trash: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func handleMove(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	var req ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	oldPath, err := safePath(req.Path)
	if err != nil {
		http.Error(w, "Invalid old path", http.StatusBadRequest)
		return
	}

	newPath, err := safePath(req.NewPath)
	if err != nil {
		http.Error(w, "Invalid new path", http.StatusBadRequest)
		return
	}

	// Ensure destination directory exists
	if err := os.MkdirAll(filepath.Dir(newPath), 0755); err != nil {
		http.Error(w, "Failed to create destination dir", http.StatusInternalServerError)
		return
	}

	if err := os.Rename(oldPath, newPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(10 << 20); err != nil { // 10MB limit
		http.Error(w, "File too large", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Get note path to determine where to save attachments
	notePath := r.FormValue("notePath")
	fullNotePath, err := safePath(notePath)
	if err != nil {
		http.Error(w, "Invalid note path", http.StatusBadRequest)
		return
	}

	// Determine attachments dir: {NoteDir}/attachments
	attachmentsDir := filepath.Join(filepath.Dir(fullNotePath), "attachments")
	if err := os.MkdirAll(attachmentsDir, 0755); err != nil {
		http.Error(w, "Failed to create attachments dir", http.StatusInternalServerError)
		return
	}

	// Sanitize filename
	filename := filepath.Base(header.Filename)
	// Add timestamp to prevent collision
	filename = fmt.Sprintf("%d_%s", time.Now().Unix(), filename)

	destPath := filepath.Join(attachmentsDir, filename)
	destFile, err := os.Create(destPath)
	if err != nil {
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		http.Error(w, "Failed to write file", http.StatusInternalServerError)
		return
	}

	// Return relative path for markdown
	relPath := fmt.Sprintf("attachments/%s", filename)
	w.Write([]byte(relPath))
}
