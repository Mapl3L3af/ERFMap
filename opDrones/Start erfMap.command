#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if (( $+commands[node] )); then
    exec node server.js
fi
for runtime in "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"; do
    if [[ -x "$runtime" ]]; then
        exec "$runtime" server.js
    fi
done
print 'Install Node.js 20 or later, then open this launcher again.'
exit 1
