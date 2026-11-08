#!/bin/zsh
cd "${0:A:h}" || exit 1
printf 'Semantic Studio: http://localhost:3010\nKeep this window open while labeling.\n'
python3 -m http.server 3010 --bind 127.0.0.1
