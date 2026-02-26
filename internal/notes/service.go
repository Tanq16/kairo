package notes

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Service struct {
	storage Store
}

func NewService(storage Store) *Service {
	return &Service{storage: storage}
}

func (s *Service) GetTree() (*FileNode, error) {
	return s.storage.GetTree()
}

func (s *Service) GetFile(path string) ([]byte, error) {
	return s.storage.ReadFile(path)
}

func (s *Service) SaveFile(path string, content string) error {
	return s.storage.SaveFile(path, []byte(content))
}

func (s *Service) CreateDir(path string) error {
	return s.storage.CreateDir(path)
}

func (s *Service) Delete(path string) error {
	return s.storage.Delete(path)
}

func (s *Service) Move(oldPath, newPath string) error {
	oldDir := filepath.ToSlash(filepath.Dir(oldPath))
	newDir := filepath.ToSlash(filepath.Dir(newPath))

	if strings.HasSuffix(strings.ToLower(oldPath), ".md") && oldDir != newDir {
		if err := s.moveAttachments(oldPath, oldDir, newDir); err != nil {
			return err
		}
	}

	if err := s.storage.Move(oldPath, newPath); err != nil {
		return err
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
		return "", err
	}

	timestampedFilename := time.Now().Format("20060102_150405") + "_" + filepath.Base(filename)
	destPath := filepath.Join(attachmentsDir, timestampedFilename)
	destFile, err := os.Create(destPath)
	if err != nil {
		return "", err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		return "", err
	}

	relPath := filepath.ToSlash(filepath.Join(parentDir, "attachments", timestampedFilename))
	return "/data/" + relPath, nil
}
