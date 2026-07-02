package notes

import (
	"errors"
	"fmt"
	"io"
	"path"
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

func (s *Service) Delete(filePath string) error {
	if err := s.storage.Delete(filePath); err != nil {
		return err
	}
	// trashing the last attachment should not leave an empty attachments dir behind
	if dir := path.Dir(filePath); path.Base(dir) == "attachments" {
		s.storage.RemoveDirIfEmpty(dir)
	}
	return nil
}

func (s *Service) Move(oldPath, newPath string) error {
	oldDir := path.Dir(oldPath)
	newDir := path.Dir(newPath)

	// the note moves first so a destination conflict fails before any attachment is relocated
	if err := s.storage.Move(oldPath, newPath); err != nil {
		return err
	}

	if strings.HasSuffix(strings.ToLower(oldPath), ".md") && oldDir != newDir {
		if err := s.moveAttachments(newPath, oldDir, newDir); err != nil {
			s.storage.Move(newPath, oldPath)
			return err
		}
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

	moved := make(map[string]string)
	var moveErr error

	processMatch := func(match, pre, src, post string) string {
		if moveErr != nil {
			return match
		}
		if strings.HasPrefix(src, "http") || strings.HasPrefix(src, "data:") {
			return match
		}

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

		// a failed attachment move aborts the whole note move so links never resolve to the wrong file
		if _, alreadyMoved := moved[dataRelPath]; !alreadyMoved {
			if exists, err := s.storage.Exists(dataRelPath); err == nil && exists {
				if err := s.storage.Move(dataRelPath, newDataRelPath); err != nil {
					moveErr = err
					return match
				}
				moved[dataRelPath] = newDataRelPath
			}
		}

		if strings.HasPrefix(src, "/data/") {
			if _, ok := moved[dataRelPath]; ok {
				return pre + "attachments/" + fileName + post
			}
		}

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

	if moveErr != nil {
		s.rollbackAttachmentMoves(moved, newDir)
		return moveErr
	}
	if updated != string(content) {
		if err := s.storage.SaveFile(notePath, []byte(updated)); err != nil {
			s.rollbackAttachmentMoves(moved, newDir)
			return err
		}
	}
	return nil
}

// best effort: a failed restore cannot make the already-surfaced error any worse
func (s *Service) rollbackAttachmentMoves(moved map[string]string, newDir string) {
	for src, dst := range moved {
		s.storage.Move(dst, src)
	}
	s.cleanupEmptyAttachmentsDir(newDir)
}

func (s *Service) cleanupEmptyAttachmentsDir(dir string) {
	attDir := "attachments"
	if dir != "." {
		attDir = dir + "/attachments"
	}
	s.storage.RemoveDirIfEmpty(attDir)
}

func (s *Service) UploadFile(notePath string, file io.Reader, filename string) (string, error) {
	dir := path.Dir(notePath)
	base := time.Now().Format("20060102_150405") + "_" + path.Base(filename)
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	// same-second uploads of a same-named file must not overwrite each other
	for n := 0; ; n++ {
		name := base
		if n > 0 {
			name = fmt.Sprintf("%s_%d%s", stem, n, ext)
		}
		relPath := "attachments/" + name
		destPath := relPath
		if dir != "." {
			destPath = dir + "/" + relPath
		}
		err := s.storage.SaveFileFrom(destPath, file)
		if err == nil {
			return relPath, nil
		}
		if !errors.Is(err, ErrExists) {
			return "", err
		}
	}
}
