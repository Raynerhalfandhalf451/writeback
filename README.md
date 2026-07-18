# writeback

Scribble on a canvas. AI writes the answer back — in the right place.

Draw a right triangle, label two sides `1` and `2`, put a `?` on the third, and pause. A few seconds later `√5 ≈ 2.24` appears right where your question mark is. Type a question and it answers below it. Ask for a diagram and it draws one. Nothing you draw is ever moved or deleted.

No API key, no backend — it uses your existing [Claude Code](https://claude.com/claude-code) login.

## About tldraw offline

[tldraw offline](https://tldraw.com) is the tldraw desktop app: an infinite-canvas whiteboard where each drawing is a local `.tldraw` file on your computer — no account, works offline. Documents can embed a **script** that adds live behavior to the canvas, and the app asks for your consent before running one. That's what makes writeback possible: the AI wiring lives inside the drawing itself and travels with the file.

## Requirements

- [tldraw offline](https://tldraw.com) desktop app
- [Claude Code](https://claude.com/claude-code) installed and logged in
- Node 18+

## Install

**1. Install tldraw offline** — download the desktop app from [tldraw.com](https://tldraw.com) (macOS DMG, Windows installer, or Linux AppImage/deb) and install it like any other app.

**2. Start the server** (leave it running):

```sh
git clone https://github.com/milind-soni/writeback.git
cd writeback
node server.mjs
```

**3. Add the script to a drawing:**

1. Open tldraw offline, create or open a document.
2. Menu: **Develop → Reveal Script…**
3. Replace the revealed `script/main.js` with this repo's [`canvas-script/main.js`](canvas-script/main.js) and save — it hot-reloads instantly.
4. Save the document (Cmd/Ctrl+S).

**4. Write or scribble on the canvas, then pause.** An ink-blot pulses while it thinks, and the answer fades in.

If the canvas says `assistant offline`, start the server again: `node server.mjs`.

## How it works

The document script watches for you to stop writing, screenshots the canvas, and POSTs it (plus every shape's coordinates) to `server.mjs` on port 7877. The server runs headless Claude Code (`claude -p`) — Claude looks at the screenshot and returns shape JSON with exact positions, which fade in on your canvas. To change its behavior, edit `PERSONA` and `CONTRACT` at the top of `server.mjs` and restart.

It uses Claude Sonnet 5 by default (fast, great at this). Pick another model with:

```sh
WRITEBACK_MODEL=claude-opus-4-8 node server.mjs
```

## License

MIT
