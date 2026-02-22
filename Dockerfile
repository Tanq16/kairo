# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git curl make nodejs npm

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Download assets, build CodeMirror bundle, and compile
ARG VERSION=dev-build
RUN make assets && make codemirror && \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w -X 'github.com/tanq16/kairo/cmd.AppVersion=${VERSION}'" -o kairo .

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app

COPY --from=builder /app/kairo .

EXPOSE 8080
ENTRYPOINT ["./kairo"]
CMD ["-d", "/data", "-H", "0.0.0.0"]
