FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git curl make nodejs npm

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG TARGETOS TARGETARCH VERSION=dev-build

RUN make assets && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build \
      -ldflags="-s -w -X 'github.com/tanq16/kairo/cmd.AppVersion=${VERSION}'" \
      -o /app/kairo .

FROM alpine:3.24.1

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S app && \
    adduser -u 10001 -S -G app app

WORKDIR /app
COPY --from=builder --chown=10001:10001 /app/kairo .

RUN mkdir -p /data && chown 10001:10001 /data
VOLUME ["/data"]

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["./kairo"]
CMD ["serve", "-d", "/data", "-H", "0.0.0.0"]
