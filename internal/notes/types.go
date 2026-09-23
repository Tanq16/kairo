package notes

import (
	"errors"
	"time"
)

var (
	ErrInvalidPath = errors.New("invalid path")
	ErrExists      = errors.New("destination already exists")
)

type FileNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"`
	IsDir    bool        `json:"isDir"`
	Children []*FileNode `json:"children,omitzero"`
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

type FileState struct {
	Size    int64
	ModTime time.Time
	IsDir   bool
}
