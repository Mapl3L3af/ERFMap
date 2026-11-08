#!/bin/zsh
cd -- "${0:A:h}" || exit 1

if (( $+commands[node] )); then
    node_cmd=node
else
    node_cmd=''
    for runtime in "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"; do
        if [[ -x "$runtime" ]]; then
            node_cmd="$runtime"
            break
        fi
    done
fi
if [[ -z "$node_cmd" ]]; then
    print 'Install Node.js 20 or later, then open this launcher again.'
    exit 1
fi

if [[ -z "${ERFMAP_PYTHON:-}" ]]; then
    python_cmd=''
    for candidate in python3 python; do
        if (( $+commands[$candidate] )) && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' 2>/dev/null; then
            python_cmd="$candidate"
            break
        fi
    done
    if [[ -z "$python_cmd" ]]; then
        print 'Install Python 3.10 or later to prepare image processing and reconstruction support.'
        exit 1
    fi

    venv_python="$PWD/.venv/bin/python"
    if [[ ! -x "$venv_python" ]]; then
        print 'Creating the erfMap Python environment…'
        "$python_cmd" -m venv .venv || { print 'Could not create .venv. Install Python venv support and retry.'; exit 1; }
    fi

    requirements_hash="$(shasum -a 256 worker/requirements.txt | cut -d ' ' -f 1)"
    stamp="$PWD/.venv/.erfmap-requirements.sha256"
    if [[ ! -f "$stamp" || "$(<"$stamp")" != "$requirements_hash" ]] || ! "$venv_python" -c 'import cv2, numpy, rasterio' 2>/dev/null; then
        print 'Preparing image processing and NodeODM reconstruction dependencies…'
        "$venv_python" -m pip install -r worker/requirements.txt || { print 'Dependency setup failed. Check the network and Python package installer, then retry.'; exit 1; }
        print -r -- "$requirements_hash" > "$stamp"
    fi
    export ERFMAP_PYTHON="$venv_python"
fi

exec "$node_cmd" server.js
