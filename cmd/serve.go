package cmd

import (
	"github.com/rs/zerolog/log"
	"github.com/spf13/cobra"
	"github.com/tanq16/kairo/internal/server"
)

var serveFlags struct {
	port    int
	host    string
	dataDir string
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the web server",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		cfg := server.Config{
			Port:    serveFlags.port,
			Host:    serveFlags.host,
			DataDir: serveFlags.dataDir,
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

func init() {
	serveCmd.Flags().IntVarP(&serveFlags.port, "port", "p", 8080, "Port to listen on")
	serveCmd.Flags().StringVarP(&serveFlags.host, "host", "H", "0.0.0.0", "Host to bind to")
	serveCmd.Flags().StringVarP(&serveFlags.dataDir, "data", "d", "./data", "Path to the data directory")
}
