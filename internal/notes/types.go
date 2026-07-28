package notes

import (
	"errors"
	"io"
)

// Sentinels let handlers map storage failures to HTTP statuses without leaking paths.
var (
	ErrInvalidPath = errors.New("invalid path")
	ErrExists      = errors.New("destination already exists")
)

type FileNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"` // Relative path
	IsDir    bool        `json:"isDir"`
	Children []*FileNode `json:"children,omitempty"`
}

type SearchResult struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Snippet string `json:"snippet,omitempty"`
	Line    int    `json:"line,omitempty"`
}

type SaveRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type ActionRequest struct {
	Path    string `json:"path"`
	NewPath string `json:"newPath,omitempty"`
}

type Store interface {
	GetTree() (*FileNode, error)
	ReadFile(path string) ([]byte, error)
	SaveFile(path string, content []byte) error
	SaveFileFrom(path string, r io.Reader) error
	CreateDir(path string) error
	Delete(path string) error
	Move(oldPath, newPath string) error
	Exists(path string) (bool, error)
	RemoveDirIfEmpty(path string) error
}
