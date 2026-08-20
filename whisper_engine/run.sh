#!/usr/bin/env bash
# ==============================================================================
#  DR Dubber — Whisper Engine Runner (macOS / Linux)
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Resolve Python interpreter (prioritizing isolated virtualenv)
if [ -x "$DIR/venv/bin/python" ]; then
    PY="$DIR/venv/bin/python"
elif [ -x "$DIR/../.venv/bin/python" ]; then
    PY="$DIR/../.venv/bin/python"
elif [ -x "$DIR/../backend/venv/bin/python" ]; then
    PY="$DIR/../backend/venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PY="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
    PY="$(command -v python)"
else
    echo "[Whisper Error] No Python 3 executable found. Run ./setup.sh first." >&2
    exit 1
fi

exec "$PY" "$DIR/transcribe.py" "$@"
