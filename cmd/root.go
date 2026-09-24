package cmd

import (
	"io"
	"os"
	"time"

	"github.com/charmbracelet/x/term"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/spf13/cobra"
	"github.com/tanq16/kairo/internal/server"
)

var AppVersion = "dev-build"

var debugFlag bool

var rootFlags struct {
	port    int
	host    string
	dataDir string
}

var rootCmd = &cobra.Command{
	Use:               "kairo",
	Short:             "A simple note-taking application with Markdown support",
	Version:           AppVersion,
	Args:              cobra.NoArgs,
	CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	Run: func(cmd *cobra.Command, args []string) {
		cfg := server.Config{
			Port:    rootFlags.port,
			Host:    rootFlags.host,
			DataDir: rootFlags.dataDir,
		}
		srv := server.New(cfg)
		if err := srv.Setup(); err != nil {
			log.Fatal().Err(err).Msg("Failed to setup server")
		}
		if err := srv.Run(); err != nil {
			log.Fatal().Err(err).Msg("Server error")
		}
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func setupLogs() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	var out io.Writer = os.Stdout
	if term.IsTerminal(os.Stdout.Fd()) {
		out = zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.DateTime}
	}
	log.Logger = zerolog.New(out).With().Timestamp().Logger()
	zerolog.SetGlobalLevel(zerolog.InfoLevel)
	if debugFlag {
		zerolog.SetGlobalLevel(zerolog.DebugLevel)
	}
}

func init() {
	rootCmd.SetHelpCommand(&cobra.Command{Hidden: true})
	rootCmd.PersistentFlags().BoolVar(&debugFlag, "debug", false, "Enable debug logging")
	cobra.OnInitialize(setupLogs)

	rootCmd.Flags().IntVarP(&rootFlags.port, "port", "p", 8080, "Port to listen on")
	rootCmd.Flags().StringVarP(&rootFlags.host, "host", "H", "0.0.0.0", "Host to bind to")
	rootCmd.Flags().StringVarP(&rootFlags.dataDir, "data", "d", "./data", "Path to the data directory")
}
