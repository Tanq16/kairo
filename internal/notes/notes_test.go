package notes

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func newTestStorage(t *testing.T) *FileStorage {
	t.Helper()
	s, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage: %v", err)
	}
	return s
}

func writeFile(t *testing.T, s *FileStorage, path, content string) {
	t.Helper()
	if err := s.SaveFile(path, []byte(content)); err != nil {
		t.Fatalf("SaveFile(%q): %v", path, err)
	}
}

func mustExist(t *testing.T, s *FileStorage, path string, want bool) {
	t.Helper()
	got, err := s.Exists(path)
	if err != nil {
		t.Fatalf("Exists(%q): %v", path, err)
	}
	if got != want {
		t.Fatalf("Exists(%q) = %v, want %v", path, got, want)
	}
}

func TestSafePath(t *testing.T) {
	s := newTestStorage(t)
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"parent traversal", "../x", true},
		{"traversal escaping via subdir", "a/../../x", true},
		{"absolute path", "/etc/passwd", true},
		{"backslash prefix", `\evil`, true},
		{"empty", "", true},
		{"dot resolves to data root", ".", true},
		{"double dot inside filename", "notes..md", false},
		{"double dot inside dir name", "a..b/c.md", false},
		{"nested note", "dir/note.md", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.safePath(tt.in)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidPath) {
					t.Fatalf("safePath(%q) err = %v, want ErrInvalidPath", tt.in, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("safePath(%q) unexpected error: %v", tt.in, err)
			}
			want := filepath.Join(s.dataDir, filepath.FromSlash(tt.in))
			if got != want {
				t.Fatalf("safePath(%q) = %q, want %q", tt.in, got, want)
			}
		})
	}
}

func TestFileStorageMove(t *testing.T) {
	t.Run("occupied destination returns sentinel", func(t *testing.T) {
		s := newTestStorage(t)
		writeFile(t, s, "a.md", "a")
		writeFile(t, s, "b.md", "b")
		if err := s.Move("a.md", "b.md"); !errors.Is(err, ErrExists) {
			t.Fatalf("Move onto existing file err = %v, want ErrExists", err)
		}
	})
	t.Run("normal move", func(t *testing.T) {
		s := newTestStorage(t)
		writeFile(t, s, "a.md", "content")
		if err := s.Move("a.md", "b.md"); err != nil {
			t.Fatalf("Move: %v", err)
		}
		mustExist(t, s, "a.md", false)
		got, err := s.ReadFile("b.md")
		if err != nil || string(got) != "content" {
			t.Fatalf("ReadFile(b.md) = %q, %v; want %q", got, err, "content")
		}
	})
	t.Run("creates missing destination parent", func(t *testing.T) {
		s := newTestStorage(t)
		writeFile(t, s, "a.md", "content")
		if err := s.Move("a.md", "new/deep/b.md"); err != nil {
			t.Fatalf("Move into missing dir: %v", err)
		}
		mustExist(t, s, "new/deep/b.md", true)
	})
	// on case-insensitive filesystems the destination Lstat resolves to the source itself
	t.Run("case-only rename", func(t *testing.T) {
		s := newTestStorage(t)
		writeFile(t, s, "Note.md", "content")
		if err := s.Move("Note.md", "note.md"); err != nil {
			t.Fatalf("case-only rename: %v", err)
		}
		got, err := s.ReadFile("note.md")
		if err != nil || string(got) != "content" {
			t.Fatalf("ReadFile(note.md) = %q, %v; want %q", got, err, "content")
		}
	})
}

func TestSaveFileFromRefusesOverwrite(t *testing.T) {
	s := newTestStorage(t)
	writeFile(t, s, "attachments/x.png", "first")
	if err := s.SaveFileFrom("attachments/x.png", strings.NewReader("second")); !errors.Is(err, ErrExists) {
		t.Fatalf("SaveFileFrom over existing file err = %v, want ErrExists", err)
	}
	got, err := s.ReadFile("attachments/x.png")
	if err != nil || string(got) != "first" {
		t.Fatalf("existing content = %q, %v; want preserved", got, err)
	}
}

func TestFileStorageDeleteToTrash(t *testing.T) {
	s := newTestStorage(t)
	writeFile(t, s, "note.md", "one")
	if err := s.Delete("note.md"); err != nil {
		t.Fatalf("first Delete: %v", err)
	}
	mustExist(t, s, "note.md", false)
	writeFile(t, s, "note.md", "two")
	if err := s.Delete("note.md"); err != nil {
		t.Fatalf("second Delete: %v", err)
	}

	entries, err := os.ReadDir(filepath.Join(s.dataDir, ".trash"))
	if err != nil {
		t.Fatalf("ReadDir(.trash): %v", err)
	}
	var trashed int
	for _, e := range entries {
		if strings.Contains(e.Name(), "note.md") {
			trashed++
		}
	}
	if trashed != 2 {
		t.Fatalf("trash holds %d entries for note.md, want 2 (same-second delete must not overwrite)", trashed)
	}
}

func TestServiceDelete(t *testing.T) {
	t.Run("removes emptied attachments dir", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		writeFile(t, s, "docs/attachments/img.png", "x")
		if err := svc.Delete("docs/attachments/img.png"); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := os.Stat(filepath.Join(s.dataDir, "docs", "attachments")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("emptied attachments dir should be removed, stat err = %v", err)
		}
	})
	t.Run("keeps attachments dir with remaining files", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		writeFile(t, s, "docs/attachments/one.png", "1")
		writeFile(t, s, "docs/attachments/two.png", "2")
		if err := svc.Delete("docs/attachments/one.png"); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		mustExist(t, s, "docs/attachments/two.png", true)
	})
	t.Run("keeps normal dir", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		writeFile(t, s, "docs/note.md", "x")
		if err := svc.Delete("docs/note.md"); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := os.Stat(filepath.Join(s.dataDir, "docs")); err != nil {
			t.Fatalf("normal dir must survive delete of its file: %v", err)
		}
	})
}

func TestServiceUploadFile(t *testing.T) {
	t.Run("rejects traversal note path", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		if _, err := svc.UploadFile("../../x", strings.NewReader("data"), "f.png"); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("UploadFile with traversal note path err = %v, want ErrInvalidPath", err)
		}
	})
	t.Run("stores under note's attachments dir", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		rel, err := svc.UploadFile("docs/note.md", strings.NewReader("img-bytes"), "photo.png")
		if err != nil {
			t.Fatalf("UploadFile: %v", err)
		}
		if !regexp.MustCompile(`^attachments/\d{8}_\d{6}_photo\.png$`).MatchString(rel) {
			t.Fatalf("returned path %q, want attachments/<timestamp>_photo.png", rel)
		}
		got, err := s.ReadFile("docs/" + rel)
		if err != nil || string(got) != "img-bytes" {
			t.Fatalf("ReadFile(docs/%s) = %q, %v; want stored upload bytes", rel, got, err)
		}
	})
	t.Run("strips directories from filename", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		rel, err := svc.UploadFile("note.md", strings.NewReader("x"), "../../evil.png")
		if err != nil {
			t.Fatalf("UploadFile: %v", err)
		}
		if !strings.HasSuffix(rel, "_evil.png") || strings.Contains(rel, "..") {
			t.Fatalf("returned path %q, want basename-only attachment name", rel)
		}
	})
	t.Run("same-second duplicate names get distinct paths", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		first, err := svc.UploadFile("note.md", strings.NewReader("first"), "image.png")
		if err != nil {
			t.Fatalf("first UploadFile: %v", err)
		}
		second, err := svc.UploadFile("note.md", strings.NewReader("second"), "image.png")
		if err != nil {
			t.Fatalf("second UploadFile: %v", err)
		}
		if first == second {
			t.Fatalf("duplicate upload returned same path %q", first)
		}
		got, err := s.ReadFile(first)
		if err != nil || string(got) != "first" {
			t.Fatalf("first upload = %q, %v; want preserved", got, err)
		}
	})
}

func TestServiceCreateFile(t *testing.T) {
	t.Run("fresh create returns name and writes content", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		got, err := svc.CreateFile("note.md", "first")
		if err != nil {
			t.Fatalf("CreateFile: %v", err)
		}
		if got != "note.md" {
			t.Fatalf("CreateFile returned %q, want %q", got, "note.md")
		}
		if b, err := s.ReadFile("note.md"); err != nil || string(b) != "first" {
			t.Fatalf("ReadFile(note.md) = %q, %v; want %q", b, err, "first")
		}
	})

	t.Run("collisions suffix -(N) before extension and leave originals intact", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		steps := []struct {
			content string
			want    string
		}{
			{"first", "note.md"},
			{"second", "note-(1).md"},
			{"third", "note-(2).md"},
		}
		for _, st := range steps {
			got, err := svc.CreateFile("note.md", st.content)
			if err != nil {
				t.Fatalf("CreateFile(note.md): %v", err)
			}
			if got != st.want {
				t.Fatalf("CreateFile(note.md) returned %q, want %q", got, st.want)
			}
		}
		// each create wrote a distinct file and never clobbered an earlier one
		for _, st := range steps {
			if b, err := s.ReadFile(st.want); err != nil || string(b) != st.content {
				t.Fatalf("ReadFile(%q) = %q, %v; want %q", st.want, b, err, st.content)
			}
		}
	})

	t.Run("nested collision preserves directory", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		if _, err := svc.CreateFile("docs/note.md", "a"); err != nil {
			t.Fatalf("first CreateFile: %v", err)
		}
		got, err := svc.CreateFile("docs/note.md", "b")
		if err != nil {
			t.Fatalf("second CreateFile: %v", err)
		}
		if got != "docs/note-(1).md" {
			t.Fatalf("CreateFile(docs/note.md) returned %q, want %q", got, "docs/note-(1).md")
		}
		if b, err := s.ReadFile("docs/note-(1).md"); err != nil || string(b) != "b" {
			t.Fatalf("ReadFile(docs/note-(1).md) = %q, %v; want %q", b, err, "b")
		}
	})

	t.Run("no-extension collision suffixes bare name", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		if _, err := svc.CreateFile("readme", "a"); err != nil {
			t.Fatalf("first CreateFile: %v", err)
		}
		got, err := svc.CreateFile("readme", "b")
		if err != nil {
			t.Fatalf("second CreateFile: %v", err)
		}
		if got != "readme-(1)" {
			t.Fatalf("CreateFile(readme) returned %q, want %q", got, "readme-(1)")
		}
	})

	t.Run("rejects traversal path", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		if _, err := svc.CreateFile("../evil.md", "x"); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("CreateFile with traversal path err = %v, want ErrInvalidPath", err)
		}
	})
}

func TestServiceMoveRewritesAttachments(t *testing.T) {
	s := newTestStorage(t)
	svc := NewService(s)

	content := strings.Join([]string{
		"![abs](/data/a/attachments/one.png)",
		"![rel](attachments/two.png)",
		`<img src="/data/a/attachments/three.png">`,
		"![web](http://example.com/x.png)",
		"![inline](data:image/png;base64,AAAA)",
		"![ghost](/data/a/attachments/ghost.png)",
	}, "\n")
	writeFile(t, s, "a/note.md", content)
	writeFile(t, s, "a/attachments/one.png", "1")
	writeFile(t, s, "a/attachments/two.png", "2")
	writeFile(t, s, "a/attachments/three.png", "3")

	if err := svc.Move("a/note.md", "b/note.md"); err != nil {
		t.Fatalf("Move: %v", err)
	}

	moved, err := s.ReadFile("b/note.md")
	if err != nil {
		t.Fatalf("ReadFile(b/note.md): %v", err)
	}
	want := []string{
		"![abs](attachments/one.png)",
		"![rel](attachments/two.png)",
		`<img src="attachments/three.png">`,
		"![web](http://example.com/x.png)",
		"![inline](data:image/png;base64,AAAA)",
		"![ghost](/data/a/attachments/ghost.png)",
	}
	if got := strings.Split(string(moved), "\n"); !slices.Equal(got, want) {
		t.Fatalf("rewritten note:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}

	mustExist(t, s, "a/note.md", false)
	for _, p := range []string{"b/attachments/one.png", "b/attachments/two.png", "b/attachments/three.png"} {
		mustExist(t, s, p, true)
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "a", "attachments")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("emptied source attachments dir should be removed, stat err = %v", err)
	}
}

func TestServiceMoveConflicts(t *testing.T) {
	t.Run("occupied note destination leaves attachments untouched", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		writeFile(t, s, "a/note.md", "![rel](attachments/img.png)")
		writeFile(t, s, "a/attachments/img.png", "1")
		writeFile(t, s, "b/note.md", "occupied")
		if err := svc.Move("a/note.md", "b/note.md"); !errors.Is(err, ErrExists) {
			t.Fatalf("Move onto existing note err = %v, want ErrExists", err)
		}
		mustExist(t, s, "a/attachments/img.png", true)
		mustExist(t, s, "b/attachments/img.png", false)
	})
	t.Run("occupied attachment destination rolls back whole move", func(t *testing.T) {
		s := newTestStorage(t)
		svc := NewService(s)
		content := "![one](attachments/one.png)\n![two](attachments/two.png)"
		writeFile(t, s, "a/note.md", content)
		writeFile(t, s, "a/attachments/one.png", "1")
		writeFile(t, s, "a/attachments/two.png", "2")
		writeFile(t, s, "b/attachments/two.png", "occupied")
		if err := svc.Move("a/note.md", "b/note.md"); !errors.Is(err, ErrExists) {
			t.Fatalf("Move with attachment conflict err = %v, want ErrExists", err)
		}
		for _, p := range []string{"a/note.md", "a/attachments/one.png", "a/attachments/two.png"} {
			mustExist(t, s, p, true)
		}
		mustExist(t, s, "b/note.md", false)
		mustExist(t, s, "b/attachments/one.png", false)
		got, err := s.ReadFile("b/attachments/two.png")
		if err != nil || string(got) != "occupied" {
			t.Fatalf("pre-existing attachment = %q, %v; want untouched", got, err)
		}
		note, err := s.ReadFile("a/note.md")
		if err != nil || string(note) != content {
			t.Fatalf("restored note = %q, %v; want unchanged content", note, err)
		}
	})
}

func TestGetTree(t *testing.T) {
	t.Run("empty data dir", func(t *testing.T) {
		s := newTestStorage(t)
		root, err := s.GetTree()
		if err != nil {
			t.Fatalf("GetTree: %v", err)
		}
		if len(root.Children) != 0 {
			t.Fatalf("empty data dir children = %v, want none", childNames(root))
		}
	})
	t.Run("nested dirs and dotfile skipping", func(t *testing.T) {
		s := newTestStorage(t)
		writeFile(t, s, "root.md", "r")
		writeFile(t, s, "docs/guide.md", "g")
		writeFile(t, s, "docs/sub/deep.md", "d")
		writeFile(t, s, ".hidden", "h")
		writeFile(t, s, ".secret/inner.md", "i")

		root, err := s.GetTree()
		if err != nil {
			t.Fatalf("GetTree: %v", err)
		}
		// .hidden, .secret, and the always-present .trash must all be absent
		if got := childNames(root); !slices.Equal(got, []string{"docs", "root.md"}) {
			t.Fatalf("root children = %v, want [docs root.md]", got)
		}

		docs := findChild(t, root, "docs")
		if !docs.IsDir || docs.Path != "docs" {
			t.Fatalf("docs node = %+v, want dir with path %q", docs, "docs")
		}
		guide := findChild(t, docs, "guide.md")
		if guide.IsDir || guide.Path != filepath.Join("docs", "guide.md") {
			t.Fatalf("guide node = %+v, want file with path %q", guide, filepath.Join("docs", "guide.md"))
		}
		sub := findChild(t, docs, "sub")
		deep := findChild(t, sub, "deep.md")
		if deep.Path != filepath.Join("docs", "sub", "deep.md") {
			t.Fatalf("deep node path = %q, want %q", deep.Path, filepath.Join("docs", "sub", "deep.md"))
		}
	})
}

func TestServiceSearch(t *testing.T) {
	type tfile struct{ path, content string }
	tests := []struct {
		name  string
		files []tfile
		query string
		want  []SearchResult
	}{
		{
			name:  "fuzzy filename match ranks ahead of content match",
			files: []tfile{{"server.md", "alpha\nbeta"}, {"guide.md", "one\nconfigure the server\nthree"}},
			query: "server",
			want: []SearchResult{
				{Path: "server.md", Name: "server.md"},
				{Path: "guide.md", Name: "guide.md", Snippet: "configure the server", Line: 2},
			},
		},
		{
			name:  "fuzzy subsequence matches non-contiguous filename in subfolder",
			files: []tfile{{"docs/server-notes.md", "body text"}},
			query: "srvnotes",
			want:  []SearchResult{{Path: filepath.Join("docs", "server-notes.md"), Name: "server-notes.md"}},
		},
		{
			name:  "case-insensitive filename match",
			files: []tfile{{"README.md", "readme body"}},
			query: "readme",
			want:  []SearchResult{{Path: "README.md", Name: "README.md"}},
		},
		{
			name:  "content match reports trimmed snippet and 1-based line",
			files: []tfile{{"notes.md", "first\n   padded keyword line   \nlast"}},
			query: "keyword",
			want:  []SearchResult{{Path: "notes.md", Name: "notes.md", Snippet: "padded keyword line", Line: 2}},
		},
		{
			name:  "multibyte snippet is rune-capped and stays valid UTF-8",
			files: []tfile{{"long.md", strings.Repeat("é", 200)}},
			query: "é",
			want:  []SearchResult{{Path: "long.md", Name: "long.md", Snippet: strings.Repeat("é", 160), Line: 1}},
		},
		{
			name:  "empty query returns nil",
			files: []tfile{{"a.md", "server content"}},
			query: "",
			want:  nil,
		},
		{
			name:  "whitespace-only query returns nil",
			files: []tfile{{"a.md", "server content"}},
			query: "   ",
			want:  nil,
		},
		{
			name:  "non-md files are excluded from name and content matches",
			files: []tfile{{"match.txt", "this line has match in it"}, {"keep.md", "unrelated"}},
			query: "match",
			want:  nil,
		},
		{
			name:  "file matched by name is not duplicated as a content hit",
			files: []tfile{{"report.md", "this report is detailed"}},
			query: "report",
			want:  []SearchResult{{Path: "report.md", Name: "report.md"}},
		},
		{
			name:  "no match is excluded",
			files: []tfile{{"alpha.md", "beta gamma"}, {"delta.md", "epsilon"}},
			query: "zzzznomatch",
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStorage(t)
			for _, f := range tt.files {
				writeFile(t, s, f.path, f.content)
			}
			got, err := NewService(s).Search(tt.query)
			if err != nil {
				t.Fatalf("Search(%q): %v", tt.query, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("Search(%q) = %+v, want %+v", tt.query, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("Search(%q)[%d] = %+v, want %+v", tt.query, i, got[i], tt.want[i])
				}
				// the rune-cap must never split a multibyte char or exceed the bound
				if !utf8.ValidString(got[i].Snippet) {
					t.Fatalf("Search(%q)[%d] snippet not valid UTF-8: %q", tt.query, i, got[i].Snippet)
				}
				if n := utf8.RuneCountInString(got[i].Snippet); n > 160 {
					t.Fatalf("Search(%q)[%d] snippet has %d runes, want <=160", tt.query, i, n)
				}
			}
		})
	}
}

func childNames(n *FileNode) []string {
	names := make([]string, 0, len(n.Children))
	for _, c := range n.Children {
		names = append(names, c.Name)
	}
	return names
}

func findChild(t *testing.T, n *FileNode, name string) *FileNode {
	t.Helper()
	for _, c := range n.Children {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("child %q not found under %q (have %v)", name, n.Name, childNames(n))
	return nil
}
