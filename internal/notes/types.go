package notes

type FileNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"` // Relative path
	IsDir    bool        `json:"isDir"`
	Children []*FileNode `json:"children,omitempty"`
}

type SaveRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type ActionRequest struct {
	Path    string `json:"path"`
	NewPath string `json:"newPath,omitempty"`
}
