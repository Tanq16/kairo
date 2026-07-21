package notes

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type FileStorage struct {
	dataDir string
}

func NewStorage(dataDir string) (*FileStorage, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, err
	}

	trashDir := filepath.Join(dataDir, ".trash")
	if err := os.MkdirAll(trashDir, 0755); err != nil {
		return nil, err
	}

	return &FileStorage{dataDir: dataDir}, nil
}

func (s *FileStorage) safePath(reqPath string) (string, error) {
	if strings.HasPrefix(reqPath, "/") || strings.HasPrefix(reqPath, "\\") {
		return "", ErrInvalidPath
	}
	// IsLocal rejects traversal without banning ".." inside legitimate names like "notes..md";
	// "." (from an empty path) is rejected because the data root is never a valid target
	clean := filepath.Clean(filepath.FromSlash(reqPath))
	if clean == "." || !filepath.IsLocal(clean) {
		return "", ErrInvalidPath
	}
	return filepath.Join(s.dataDir, clean), nil
}

func (s *FileStorage) GetTree() (*FileNode, error) {
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

		for i := range len(parts) - 1 {
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

func (s *FileStorage) ReadFile(path string) ([]byte, error) {
	fullPath, err := s.safePath(path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(fullPath)
}

func (s *FileStorage) SaveFile(path string, content []byte) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	// Write a same-dir temp then rename over the target: concurrent saves can't tear the
	// file, readers never see a half-written note, and a dot-prefixed crash leftover stays
	// out of GetTree (which skips dotfiles).
	tmp, err := os.CreateTemp(dir, ".kairo-save-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0644); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, fullPath); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func (s *FileStorage) CreateDir(path string) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	return os.MkdirAll(fullPath, 0755)
}

func (s *FileStorage) Delete(path string) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	trashDir := filepath.Join(s.dataDir, ".trash")
	name := fmt.Sprintf("%s_%s", time.Now().Format("20060102_150405"), filepath.Base(fullPath))
	trashPath := filepath.Join(trashDir, name)
	// same-second deletes of a same-named file must not overwrite earlier trash entries
	for n := 1; ; n++ {
		if _, err := os.Lstat(trashPath); err != nil {
			break
		}
		trashPath = filepath.Join(trashDir, fmt.Sprintf("%s_%d", name, n))
	}
	return os.Rename(fullPath, trashPath)
}

func (s *FileStorage) Move(oldPath, newPath string) error {
	oldFullPath, err := s.safePath(oldPath)
	if err != nil {
		return err
	}
	newFullPath, err := s.safePath(newPath)
	if err != nil {
		return err
	}
	// os.Rename silently replaces existing files, so refuse occupied destinations;
	// on case-insensitive filesystems a case-only rename resolves to the source itself and stays allowed
	if newInfo, err := os.Lstat(newFullPath); err == nil {
		oldInfo, oldErr := os.Lstat(oldFullPath)
		if oldErr != nil || !os.SameFile(oldInfo, newInfo) {
			return ErrExists
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(newFullPath), 0755); err != nil {
		return err
	}
	return os.Rename(oldFullPath, newFullPath)
}

func (s *FileStorage) SaveFileFrom(path string, r io.Reader) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return err
	}
	// exclusive create so same-second uploads of a same-named file surface ErrExists instead of clobbering
	f, err := os.OpenFile(fullPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return ErrExists
		}
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func (s *FileStorage) Exists(path string) (bool, error) {
	fullPath, err := s.safePath(path)
	if err != nil {
		return false, err
	}
	if _, err := os.Lstat(fullPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *FileStorage) RemoveDirIfEmpty(path string) error {
	fullPath, err := s.safePath(path)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return os.Remove(fullPath)
	}
	return nil
}
