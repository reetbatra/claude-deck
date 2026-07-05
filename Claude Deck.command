#!/bin/bash
# Double-click me to start Claude Deck.
cd "$(dirname "$0")"

# If it's already running, just open the page.
if curl -s -o /dev/null --max-time 1 http://localhost:4747/api/runs; then
  open "http://localhost:4747"
  exit 0
fi

NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
if [ ! -x "$NODE_BIN" ] && [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node; fi
if [ ! -x "$NODE_BIN" ]; then
  osascript -e 'display alert "Claude Deck" message "Node.js is not installed. Ask a teammate to install it from nodejs.org, then double-click again."'
  exit 1
fi

echo "Starting Claude Deck… (keep this window open, or press Ctrl+C to stop)"
exec "$NODE_BIN" server.js --open
