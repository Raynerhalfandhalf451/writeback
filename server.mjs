// Riddle Diary companion server.
// The tldraw document script POSTs canvas turns here; we invoke headless
// Claude Code (`claude -p`, uses your existing login — no API key) and relay
// its shape JSON back to the canvas.
//
// Run:  node ~/Documents/mywork/riddle-diary/server.mjs

import http from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 7877
// Which Claude model answers canvas turns. Sonnet is the speed/quality sweet
// spot here; override with e.g. WRITEBACK_MODEL=claude-opus-4-8
const MODEL = process.env.WRITEBACK_MODEL || 'claude-sonnet-5'
const WORKDIR = join(tmpdir(), 'riddle-diary')
mkdirSync(WORKDIR, { recursive: true })

const PERSONA = `You are a canvas assistant embedded in an infinite whiteboard. The user writes or sketches on the canvas; you respond by adding shapes and text in exactly the right place. Be utility-focused and concise — no persona, no flourish.

What you do:
- Solve what is written or drawn: math problems, labeled diagrams, fill-in-the-blank marks, questions. If the user drew a right triangle with sides labeled "1" and "2" and a "?" on the third side, write the value (e.g. "√5 ≈ 2.24") right at the "?".
- Annotate diagrams: label parts, add measurements, complete missing pieces.
- Draw when drawing is the better answer: use geo shapes, lines, arrows, and freehand "draw" strokes to sketch diagrams, graphs, or illustrations the user asks for.
- Answer written questions with short text placed near the question.`

const CONTRACT = `You must reply with ONLY a JSON object (no markdown fences, no prose outside it):
{"shapes": [ ...one or more shape objects... ]}

Allowed shape objects (page coordinates, y grows downward):
- {"kind":"text","x":N,"y":N,"text":"...","color":"black","size":"m"}   // handwritten reply text. size: s|m|l
- {"kind":"geo","geo":"rectangle"|"ellipse"|"cloud"|"star","x":N,"y":N,"w":N,"h":N,"text":"optional","color":"black"}
- {"kind":"note","x":N,"y":N,"text":"...","color":"yellow"}
- {"kind":"line","x1":N,"y1":N,"x2":N,"y2":N,"color":"black"}
- {"kind":"arrow","x1":N,"y1":N,"x2":N,"y2":N,"text":"optional","color":"black"}
- {"kind":"draw","color":"black","points":[[x,y],[x,y],...]}            // freehand stroke, 10-80 points, page coords

Colors: black, grey, red, blue, green, orange, violet, light-violet, yellow, white.

Placement rules (this is the most important part — placement must be contextually CORRECT):
- Nothing on the canvas is ever removed. Your shapes are added alongside the user's ink and all previous replies, so pick empty space and never overlap existing shapes.
- If the user marked a "?" or left an obvious blank, put the answer AT that spot (right next to the "?" mark), sized to match the neighboring labels — study the screenshot and the shape coordinates carefully to find the exact page position.
- For a labeled diagram (e.g. triangle sides), the value goes ON the relevant side/part, like a label the user would have written themselves.
- For a written question, put the answer just below or beside the question text, left-aligned with it.
- Text lines: keep each text shape under ~60 characters; stack multiple text shapes ~44px apart vertically for multi-line answers.
- Prefer a small precise answer over a paragraph. Draw diagrams with geo/line/arrow/draw shapes when the user asks for a drawing or a visual completes the answer.
- Reply with at most 12 shapes.`

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--model', MODEL], {
      cwd: WORKDIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timed out')) }, 180_000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))
      resolve(out)
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

function extractJson(text) {
  // Model was told to emit bare JSON, but be forgiving about fences/prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON object in reply')
  return JSON.parse(candidate.slice(start, end + 1))
}

async function handleTurn(body) {
  const { shapes = [], userInput = {}, screenshotDataUrl, history = [] } = body

  let screenshotLine = '(no screenshot available — rely on the shape data)'
  if (screenshotDataUrl && screenshotDataUrl.startsWith('data:image/')) {
    const b64 = screenshotDataUrl.slice(screenshotDataUrl.indexOf(',') + 1)
    const ext = screenshotDataUrl.includes('image/png') ? 'png' : 'jpg'
    const file = join(WORKDIR, `canvas-${Date.now()}.${ext}`)
    writeFileSync(file, Buffer.from(b64, 'base64'))
    screenshotLine = `First, use the Read tool to look at the canvas screenshot: ${file}\nIt shows everything on the page, including any handwriting or scribbles the shape data cannot capture.`
  }

  const historyLines = history
    .slice(-30)
    .map((h) => `${h.role === 'diary' ? 'Assistant' : 'User'}: ${h.text}`)
    .join('\n')

  const prompt = [
    PERSONA,
    '',
    screenshotLine,
    '',
    'Current shapes on the page (page coordinates):',
    JSON.stringify(shapes).slice(0, 12_000),
    '',
    `The writer's NEW input occupies bounds: ${JSON.stringify(userInput.bounds ?? null)}.`,
    userInput.text ? `Text they wrote: ${JSON.stringify(userInput.text)}` : 'They scribbled/drew something rather than typing — read it from the screenshot.',
    '',
    historyLines ? `Conversation so far:\n${historyLines}` : 'This is the first interaction on this canvas.',
    '',
    CONTRACT,
  ].join('\n')

  const raw = await callClaude(prompt)
  const envelope = JSON.parse(raw) // claude -p --output-format json envelope
  if (envelope.is_error) throw new Error(`claude error: ${String(envelope.result).slice(0, 300)}`)
  const reply = extractJson(envelope.result)
  if (!Array.isArray(reply.shapes)) throw new Error('reply missing shapes array')
  reply.shapes = reply.shapes.slice(0, 12)
  return reply
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true }))
  }
  if (req.method === 'POST' && req.url === '/turn') {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 30_000_000) req.destroy() })
    req.on('end', async () => {
      try {
        const reply = await handleTurn(JSON.parse(data))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      } catch (e) {
        console.error('[turn]', e.message)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }
  res.writeHead(404); res.end()
})

server.listen(PORT, '127.0.0.1', () => console.log(`writeback server on http://127.0.0.1:${PORT} (model: ${MODEL})`))
