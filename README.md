# Kairō

A simple note-taking application with Markdown support, built in Go.

## Features

- **Markdown Editing**: Write and edit Markdown notes with syntax highlighting using CodeJar
- **Live Preview**: Toggle between edit and preview modes with real-time rendering
- **File Management**: Create, delete, move, and rename files and folders
- **File Upload**: Upload files to attach to your notes
- **Mermaid Diagrams**: Render Mermaid diagrams in your notes
- **Callout Blocks**: Support for styled callouts (TIP, NOTE, INFO, WARNING, DANGER)
- **Code Highlighting**: Syntax highlighting for code blocks with copy-to-clipboard functionality
- **Dark Theme**: Beautiful Catppuccin Mocha theme (dark mode only)
- **Lucide Icons**: Modern icon set throughout the interface
- **Responsive Design**: Works on both desktop and mobile devices
- **Self-Contained**: Single Go binary with embedded frontend assets

## Screenshots

<details>
<summary>Click to expand screenshots</summary>

*Screenshots coming soon*

</details>

## Installation and Usage

### Binary

Download from [releases](https://github.com/tanq16/kairo/releases) and run:

```bash
./kairo --port 8080
```

### Build from Source

```bash
git clone https://github.com/tanq16/kairo
cd kairo
go build -o kairo .
./kairo
```

### Command Options

- `--port, -p`: Port to listen on (default: 8080)
- `--host, -H`: Host to bind to (default: 0.0.0.0)
- `--data, -d`: Path to the data directory (default: ./data)

Once the server is running, open your browser and navigate to the displayed URL (e.g., `http://localhost:8080`).

## Tips and Notes

- The default data directory is `./data` - all your notes will be stored there
- You can specify a custom data directory with the `--data` flag
- The application supports nested folders - create folders by ending the name with `/` when creating new items
- Mermaid diagrams are rendered automatically when you use ` ```mermaid ` code blocks
- Callout blocks use the format: `> [!TIP]` or `> [!NOTE]` etc.
- Files are auto-saved as you type - look for the save indicator in the toolbar
- The sidebar can be toggled on desktop and mobile for a cleaner editing experience
