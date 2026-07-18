# writeback

Scribble on an infinite canvas. AI writes the answer back — in the right place.

Draw a right triangle, label two sides `1` and `2`, put a `?` on the third side, and pause. A little ink-blot pulses for a few seconds, then `√5 ≈ 2.24` appears right where your question mark is. Write a question in the corner and the answer shows up under it. Ask for a diagram and it sketches one next to your notes.

No API key. No cloud backend. It runs on the [tldraw offline](https://tldraw.com) desktop app and your existing [Claude Code](https://claude.com/claude-code) login.

## How it works

```
you scribble ──► document script (inside the .tldraw file)
                   │  waits for you to pause, then exports a JPEG
                   │  of the canvas + every shape's coordinates
                   ▼
               local server (server.mjs, port 7877)
                   │  invokes headless Claude Code (`claude -p`)
                   │  Claude *looks* at the screenshot, reads the
                   │  coordinates, returns shape JSON with positions
                   ▼
               shapes fade in on your canvas, placed in context
```

Two files, that's the whole system:

- **`canvas-script/main.js`** — a tldraw *document script*. It lives inside the drawing itself: detects when you stop writing (~2.5s idle, or finishing a text edit), screenshots the canvas, POSTs to the local server, and renders the reply shapes with a staggered ink fade-in. Nothing you draw is ever moved or deleted.
- **`server.mjs`** — a zero-dependency Node server. It saves the screenshot to a temp file and runs `claude -p` (headless Claude Code, your login, your default model) with a placement-obsessed prompt. Each canvas turn is one small Claude Code call, billed to your normal subscription usage.

Conversation history persists on a hidden shape inside the document, so it survives save/close/reopen — and travels with the file.

## Requirements

- [tldraw offline](https://tldraw.com) desktop app (macOS / Windows / Linux)
- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH)
- Node 18+

## Try it

```sh
git clone https://github.com/milind-soni/writeback.git
cd writeback
node server.mjs        # leave this running — http://127.0.0.1:7877
```

Then install the canvas script into a drawing:

1. Open tldraw offline and create (or open) a document.
2. Menu: **Develop → Reveal Script…** — this reveals the document's live `script/main.js`.
3. Replace that file's contents with this repo's [`canvas-script/main.js`](canvas-script/main.js) and save it. The app hot-reloads the script instantly (no restart).
4. **Save the document** (Cmd/Ctrl+S). The script is embedded in the `.tldraw` file from now on.
5. Write or scribble something on the canvas, then stop. Watch the ink-blot.

If the canvas says `assistant offline`, the server isn't running — start it with `node server.mjs`.

Sharing: send someone your saved `.tldraw` file and this repo. When they open the file, tldraw asks whether to run the embedded script (that consent prompt is tldraw's trust gate for shared scripted documents) — they approve, start the server, and the same canvas talks to *their* Claude account, with the conversation history still inside the file.

## What it can draw

Replies come back as plain shape JSON that the script validates and renders: handwritten-style text, rectangles / ellipses / triangles and other geo shapes, lines, arrows, sticky notes, and freehand `draw` strokes — so it can label your diagram, finish your sketch, or draw you a new one.

## Tuning

The whole personality lives in two constants at the top of `server.mjs` — `PERSONA` (what it is) and `CONTRACT` (the shape JSON format + placement rules). Edit them and restart the server. It started life as a Tom Riddle diary that absorbed your ink and wrote back in character; the current prompt is utility-only. Both make a fun five-minute mod.

## License

MIT
