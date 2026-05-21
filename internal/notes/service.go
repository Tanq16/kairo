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
var htmlImageRe = regexp.MustCompile(`(<img[^>]+src=["'])([^"']+)(["'][^>]*>)`)

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

	processMatch := func(match, pre, src, post string) string {
		if strings.HasPrefix(src, "http") || strings.HasPrefix(src, "data:") {
			return match
		}

		// It should be a relative path like `attachments/foo.png`
		// It might be URL encoded, so we could decode, but for file matching we assume standard paths
		// Let's decode it for file system matching just in case
		// Actually, in the text we want to KEEP it exactly as is, we just move the file underneath.
		// Wait, if we keep it as `attachments/foo.png`, we don't need to change the markdown text at all!
		// But we still need to move the file.

		// Determine data relative path.
		// If src is `attachments/foo.png` and oldDir is `folder`, dataRelPath is `folder/attachments/foo.png`.
		// But if it's already an absolute-looking path like `/data/...`, we handle it. (Legacy support)
		var dataRelPath string
		if strings.HasPrefix(src, "/data/") {
			dataRelPath = strings.TrimPrefix(src, "/data/")
		} else {
			if oldDir == "." {
				dataRelPath = src
			} else {
				dataRelPath = oldDir + "/" + src
			}
		}

		if !strings.HasPrefix(dataRelPath, oldAttPrefix) {
			return match
		}

		fileName := strings.TrimPrefix(dataRelPath, oldAttPrefix)
		var newDataRelPath string
		if newDir == "." {
			newDataRelPath = "attachments/" + fileName
		} else {
			newDataRelPath = newDir + "/attachments/" + fileName
		}

		if _, alreadyMoved := moved[dataRelPath]; !alreadyMoved {
			fullPath := filepath.Join(s.storage.DataDir(), filepath.FromSlash(dataRelPath))
			if _, err := os.Stat(fullPath); err == nil {
				if moveErr := s.storage.Move(dataRelPath, newDataRelPath); moveErr == nil {
					moved[dataRelPath] = newDataRelPath
				}
			}
		}

		// If it's a legacy absolute path, rewrite it to relative
		if strings.HasPrefix(src, "/data/") {
			if _, ok := moved[dataRelPath]; ok {
				return pre + "attachments/" + fileName + post
			}
		}

		// If it's already relative, we don't need to rewrite the src in the markdown!
		// `attachments/foo.png` remains `attachments/foo.png` in the new folder.
		return match
	}

	updated := mdImageRe.ReplaceAllStringFunc(string(content), func(match string) string {
		parts := mdImageRe.FindStringSubmatch(match)
		return processMatch(match, parts[1], parts[2], parts[3])
	})

	updated = htmlImageRe.ReplaceAllStringFunc(updated, func(match string) string {
		parts := htmlImageRe.FindStringSubmatch(match)
		return processMatch(match, parts[1], parts[2], parts[3])
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

	// We return a path relative to the note's directory
	relPath := filepath.ToSlash(filepath.Join("attachments", timestampedFilename))
	return relPath, nil
}
