package cmd

import (
	"fmt"
	"log"
	"os"

	"github.com/spf13/cobra"
	"github.com/tanq16/kairo/internal/server"
)

var AppVersion = "dev-build"

var rootFlags struct {
	port    int
	host    string
	dataDir string
}

var rootCmd = &cobra.Command{
	Use:     "kairo",
	Short:   "A simple note-taking application with Markdown support",
	Version: AppVersion,
	CompletionOptions: cobra.CompletionOptions{
		HiddenDefaultCmd: true,
	},
	Run: func(cmd *cobra.Command, args []string) {
		cfg := server.Config{
			Port:    rootFlags.port,
			Host:    rootFlags.host,
			DataDir: rootFlags.dataDir,
		}
		srv := server.New(cfg)
		if err := srv.Setup(); err != nil {
			log.Fatalf("ERROR [cmd] Failed to setup server: %v", err)
		}
		if err := srv.Run(); err != nil {
			log.Fatalf("ERROR [cmd] Server error: %v", err)
		}
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.SetHelpCommand(&cobra.Command{Hidden: true})

	rootCmd.Flags().IntVarP(&rootFlags.port, "port", "p", 8080, "Port to listen on")
	rootCmd.Flags().StringVarP(&rootFlags.host, "host", "H", "0.0.0.0", "Host to bind to")
	rootCmd.Flags().StringVarP(&rootFlags.dataDir, "data", "d", "./data", "Path to the data directory")
}
