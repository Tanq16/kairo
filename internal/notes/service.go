package notes

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
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
	if err := s.storage.Move(oldPath, newPath); err != nil {
		return fmt.Errorf("failed to move: %w", err)
	}
	return nil
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

	relPath := fmt.Sprintf("%s/attachments/%s", parentDir, timestampedFilename)
	return relPath, nil
}
