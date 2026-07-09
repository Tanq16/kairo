package notes

import (
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/sahilm/fuzzy"
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

func (s *Service) CreateFile(p, content string) (string, error) {
	ext := path.Ext(p)
	stem := strings.TrimSuffix(p, ext)
	// mirror UploadFile: suffix "-(N)" before the extension so a create never overwrites an existing file
	for n := 0; ; n++ {
		candidate := p
		if n > 0 {
			candidate = fmt.Sprintf("%s-(%d)%s", stem, n, ext)
		}
		err := s.storage.SaveFileFrom(candidate, strings.NewReader(content))
		if err == nil {
			return candidate, nil
		}
		if !errors.Is(err, ErrExists) {
			return "", err
		}
	}
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

const maxSearchResults = 50

func (s *Service) Search(query string) ([]SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	root, err := s.storage.GetTree()
	if err != nil {
		return nil, err
	}

	var files []*FileNode
	var walk func(n *FileNode)
	walk = func(n *FileNode) {
		for _, c := range n.Children {
			if c.IsDir {
				walk(c)
			} else if strings.HasSuffix(strings.ToLower(c.Name), ".md") {
				files = append(files, c)
			}
		}
	}
	walk(root)

	names := make([]string, len(files))
	for i, f := range files {
		names[i] = f.Name
	}

	matched := make(map[string]bool)
	var results []SearchResult
	for _, m := range fuzzy.Find(query, names) {
		f := files[m.Index]
		matched[f.Path] = true
		results = append(results, SearchResult{Path: f.Path, Name: f.Name})
		if len(results) >= maxSearchResults {
			return results, nil
		}
	}

	// content matches stay substring, not fuzzy — fuzzy full-text is noisy
	q := strings.ToLower(query)
	for _, f := range files {
		if matched[f.Path] {
			continue
		}
		content, err := s.storage.ReadFile(f.Path)
		if err != nil {
			continue // a file that vanished mid-walk is not a search failure
		}
		if snippet, line, ok := firstMatch(string(content), q); ok {
			results = append(results, SearchResult{Path: f.Path, Name: f.Name, Snippet: snippet, Line: line})
			if len(results) >= maxSearchResults {
				break
			}
		}
	}

	return results, nil
}

func firstMatch(content, q string) (string, int, bool) {
	for i, line := range strings.Split(content, "\n") {
		if strings.Contains(strings.ToLower(line), q) {
			snippet := strings.TrimSpace(line)
			if r := []rune(snippet); len(r) > 160 {
				snippet = string(r[:160]) // rune-cap so a multibyte char is never split
			}
			return snippet, i + 1, true
		}
	}
	return "", 0, false
}
