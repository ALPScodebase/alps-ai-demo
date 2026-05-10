#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage:
  scripts/run_generated_stack_toxiproxy.sh NUM_ORACLES NETWORK_SEED [generator args...]

Examples:
  scripts/run_generated_stack_toxiproxy.sh 7 123
  scripts/run_generated_stack_toxiproxy.sh 10 999 --toxiproxy-latency-ms 100
  scripts/run_generated_stack_toxiproxy.sh 16 123 --toxiproxy-jitter-ms 20

Environment overrides:
  ENV_FILE=.env
  COMPOSE_FILE=docker-compose.generated.toxiproxy.yml

The script:
  1. creates .env from .env.example if .env is missing
  2. runs scripts/generate_compose_toxiproxy.py
  3. runs docker compose up --build with the generated Compose file
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

if [ "$#" -lt 2 ]; then
    usage >&2
    exit 2
fi

NUM_ORACLES="$1"
NETWORK_SEED="$2"
shift 2

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.generated.toxiproxy.yml}"
PYTHON_BIN="${PYTHON_BIN:-python3}" # Allow overriding the Python binary, e.g. to use a virtual environment

cd "$REPO_ROOT"

cat <<'EOF'
[TOXIPROXY] First-time runs can be slow while Docker pulls images and Go modules.
[TOXIPROXY] To warm the main images beforehand, run:
[TOXIPROXY]   docker pull ghcr.io/shopify/toxiproxy:2.12.0
[TOXIPROXY]   docker pull curlimages/curl:8.10.1
[TOXIPROXY]   docker pull golang:1.24-alpine
[TOXIPROXY]   docker pull node:18-alpine
[TOXIPROXY]   docker pull alpine:latest
[TOXIPROXY]   docker pull ipfs/kubo:latest
[TOXIPROXY] If digest computation times out, rerun with: --digest-timeout-seconds 3600
EOF

if [ ! -f "$ENV_FILE" ]; then
    if [ "$ENV_FILE" = ".env" ] && [ -f ".env.example" ]; then
        echo "[TOXIPROXY] .env missing; creating it from .env.example"
        cp .env.example .env
    else
        echo "[TOXIPROXY] Env file not found: $ENV_FILE" >&2
        exit 1
    fi
fi

echo "[TOXIPROXY] Generating Compose stack for NUM_ORACLES=${NUM_ORACLES}, NETWORK_SEED=${NETWORK_SEED}"
echo "[TOXIPROXY] Using Python binary: ${PYTHON_BIN}"
if ! ${PYTHON_BIN} scripts/generate_compose_toxiproxy.py \
    --num-oracles "$NUM_ORACLES" \
    --network-seed "$NETWORK_SEED" \
    --out "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    "$@"
then
    cat >&2 <<'EOF'
[TOXIPROXY] Generation failed, so Docker Compose was not started.
[TOXIPROXY] The config digest cache is only updated after a digest is computed successfully.
[TOXIPROXY] For a slow first Docker-based digest computation, try:
[TOXIPROXY]   scripts/run_generated_stack_toxiproxy.sh NUM_ORACLES NETWORK_SEED --digest-timeout-seconds 3600
[TOXIPROXY] Or pre-warm the helper image:
[TOXIPROXY]   docker pull golang:1.24-alpine
EOF
    exit 1
fi

NO_ATTACH_ARGS="$(
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config --services \
        | awk '/^toxiproxy[0-9]+$/ { printf " --no-attach %s", $0 }'
)"

echo "[TOXIPROXY] Starting generated Docker Compose stack"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up --build $NO_ATTACH_ARGS
