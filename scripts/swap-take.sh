#!/bin/zsh
# Drops a fresh recording (the goal lines, the sponsor lines, or both) into the video and re-renders it (about 3 minutes).
# usage: scripts/swap-take.sh ~/Downloads/<recording>.m4a
set -e
cd "${0:A:h}/.."
if ! lsof -i :4640 -sTCP:LISTEN >/dev/null 2>&1; then
  (cd ../player-two-brain-deck && nohup python3 -m http.server 4640 >/dev/null 2>&1 &)
  sleep 1
fi
uv run --quiet --python 3.12 --with mlx-whisper python scripts/new-take.py "$1"
uv run --quiet --with numpy python scripts/assemble-vo.py | tail -1 | cut -c1-120
echo "done: media/player-two-brains-vo.mp4 and media/player-two-brains-vo-preview.mp4"
