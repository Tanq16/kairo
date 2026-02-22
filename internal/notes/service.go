package notes

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Service struct {
	storage *Storage
}

func NewService(storage *Storage) *Service {
	return &Service{storage: storage}
}

func (s *Service) GetTree() (*FileNode, error) {
	root, err := s.storage.GetTree()
	if err != nil {
		return nil, fmt.Errorf("failed to get tree: %w", err)
	}
	return root, nil
}

func (s *Service) GetFile(path string) ([]byte, error) {
	content, err := s.storage.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("file not found")
		}
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	return content, nil
}

func (s *Service) SaveFile(path string, content string) error {
	if err := s.storage.SaveFile(path, []byte(content)); err != nil {
		return fmt.Errorf("failed to save file: %w", err)
	}
	return nil
}

func (s *Service) CreateDir(path string) error {
	if err := s.storage.CreateDir(path); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	return nil
}

func (s *Service) Delete(path string) error {
	if err := s.storage.Delete(path); err != nil {
		return fmt.Errorf("failed to delete: %w", err)
	}
	return nil
}

func (s *Service) Move(oldPath, newPath string) error {
	oldDir := filepath.ToSlash(filepath.Dir(oldPath))
	newDir := filepath.ToSlash(filepath.Dir(newPath))

	if strings.HasSuffix(strings.ToLower(oldPath), ".md") && oldDir != newDir {
		if err := s.moveAttachments(oldPath, oldDir, newDir); err != nil {
			return fmt.Errorf("failed to move attachments: %w", err)
		}
	}

	if err := s.storage.Move(oldPath, newPath); err != nil {
		return fmt.Errorf("failed to move: %w", err)
	}

	if strings.HasSuffix(strings.ToLower(oldPath), ".md") && oldDir != newDir {
		s.cleanupEmptyAttachmentsDir(oldDir)
	}

	return nil
}

var mdImageRe = regexp.MustCompile(`(!\[[^\]]*\]\()([^)]+)(\))`)

func (s *Service) moveAttachments(notePath, oldDir, newDir string) error {
	content, err := s.storage.ReadFile(notePath)
	if err != nil {
		return err
	}

	var oldAttPrefix string
	if oldDir == "." {
		oldAttPrefix = "attachments/"
	} else {
		oldAttPrefix = oldDir + "/attachments/"
	}

	moved := make(map[string]string) // old data-relative path -> new data-relative path

	updated := mdImageRe.ReplaceAllStringFunc(string(content), func(match string) string {
		parts := mdImageRe.FindStringSubmatch(match)
		src := parts[2]

		if strings.HasPrefix(src, "http") {
			return match
		}

		if !strings.HasPrefix(src, "/data/") {
			return match
		}

		dataRelPath := strings.TrimPrefix(src, "/data/")

		if !strings.HasPrefix(dataRelPath, oldAttPrefix) {
			return match
		}

		filename := strings.TrimPrefix(dataRelPath, oldAttPrefix)
		var newDataRelPath string
		if newDir == "." {
			newDataRelPath = "attachments/" + filename
		} else {
			newDataRelPath = newDir + "/attachments/" + filename
		}

		if _, alreadyMoved := moved[dataRelPath]; !alreadyMoved {
			fullPath := filepath.Join(s.storage.DataDir(), filepath.FromSlash(dataRelPath))
			if _, err := os.Stat(fullPath); err == nil {
				if moveErr := s.storage.Move(dataRelPath, newDataRelPath); moveErr == nil {
					moved[dataRelPath] = newDataRelPath
				}
			}
		}

		if newPath, ok := moved[dataRelPath]; ok {
			return parts[1] + "/data/" + newPath + parts[3]
		}

		return match
	})

	if updated != string(content) {
		return s.storage.SaveFile(notePath, []byte(updated))
	}
	return nil
}

func (s *Service) cleanupEmptyAttachmentsDir(dir string) {
	var attDir string
	if dir == "." {
		attDir = "attachments"
	} else {
		attDir = dir + "/attachments"
	}
	fullPath := filepath.Join(s.storage.DataDir(), filepath.FromSlash(attDir))

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return
	}
	if len(entries) == 0 {
		os.Remove(fullPath)
	}
}

func (s *Service) UploadFile(notePath string, file io.Reader, filename string) (string, error) {
	parentDir := filepath.Dir(notePath)
	attachmentsDir := filepath.Join(s.storage.DataDir(), parentDir, "attachments")
	if err := os.MkdirAll(attachmentsDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create attachments dir: %w", err)
	}

	timestampedFilename := fmt.Sprintf("%d_%s", time.Now().Unix(), filepath.Base(filename))
	destPath := filepath.Join(attachmentsDir, timestampedFilename)
	destFile, err := os.Create(destPath)
	if err != nil {
		return "", fmt.Errorf("failed to save file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		return "", fmt.Errorf("failed to write file: %w", err)
	}

	relPath := filepath.ToSlash(filepath.Join(parentDir, "attachments", timestampedFilename))
	return "/data/" + relPath, nil
}
