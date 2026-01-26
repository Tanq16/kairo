package notes

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Storage struct {
	dataDir string
}

func (s *Storage) DataDir() string {
	return s.dataDir
}

func NewStorage(dataDir string) (*Storage, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	trashDir := filepath.Join(dataDir, ".trash")
	if err := os.MkdirAll(trashDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create trash directory: %w", err)
	}

	return &Storage{dataDir: dataDir}, nil
}

func (s *Storage) safePath(reqPath string) (string, error) {
	clean := filepath.Clean(reqPath)
	if strings.Contains(clean, "..") || strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, "\\") {
		return "", fmt.Errorf("invalid path")
	}
	return filepath.Join(s.dataDir, clean), nil
}

func (s *Storage) GetTree() (*FileNode, error) {
	root := &FileNode{Name: "root", Path: "", IsDir: true, Children: []*FileNode{}}

	err := filepath.WalkDir(s.dataDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relPath, _ := filepath.Rel(s.dataDir, path)
		if relPath == "." {
			return nil
		}

		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		parts := strings.Split(relPath, string(os.PathSeparator))
		current := root

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
				newNode := &FileNode{Name: part, Path: filepath.Join(parts[:i+1]...), IsDir: true, Children: []*FileNode{}}
				current.Children = append(current.Children, newNode)
				current = newNode
			}
		}

		node := &FileNode{Name: d.Name(), Path: relPath, IsDir: d.IsDir()}
		if d.IsDir() {
			node.Children = []*FileNode{}
		}
		current.Children = append(current.Children, node)
		return nil
	})

	if err != nil {
		return nil, err
	}

	return root, nil
}

func (s *Storage) ReadFile(path string) ([]byte, error) {
	fullPath, err := s.safePath(path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(fullPath)
}

func (s *Storage) SaveFile(path string, content []byte) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return fmt.Errorf("could not create directory: %w", err)
	}
	return os.WriteFile(fullPath, content, 0644)
}

func (s *Storage) CreateDir(path string) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	return os.MkdirAll(fullPath, 0755)
}

func (s *Storage) Delete(path string) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	trashDir := filepath.Join(s.dataDir, ".trash")
	timestamp := time.Now().Format("20060102_150405")
	baseName := filepath.Base(fullPath)
	trashPath := filepath.Join(trashDir, fmt.Sprintf("%s_%s", timestamp, baseName))
	return os.Rename(fullPath, trashPath)
}

func (s *Storage) Move(oldPath, newPath string) error {
	oldFullPath, err := s.safePath(oldPath)
	if err != nil {
		return fmt.Errorf("invalid old path: %w", err)
	}
	newFullPath, err := s.safePath(newPath)
	if err != nil {
		return fmt.Errorf("invalid new path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(newFullPath), 0755); err != nil {
		return fmt.Errorf("failed to create destination dir: %w", err)
	}
	return os.Rename(oldFullPath, newFullPath)
}
