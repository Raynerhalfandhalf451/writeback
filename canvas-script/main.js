// Tom Riddle's diary.
//
// Watches the user's ink on the page. When they pause (or finish editing a
// text/note), the current board is sent to a local "diary" companion server
// as a screenshot + shape summary + conversation history. While the diary
// "thinks" (a pulsing ink-blot), nothing is removed — the user's ink and all
// previous replies stay on the page. The reply is drawn onto the page at the
// contextually correct spot (e.g. an answer written where a "?" was drawn),
// fading in like ink appearing.
//
// Conversation history is persisted inside the document itself, on a hidden
// locked bookkeeping shape (offscreen, meta.riddle === 'diary'), so it
// survives save/reopen.

import { createShapeId, toRichText, compressLegacySegments } from 'tldraw'

const SERVER_URL = 'http://127.0.0.1:7877/turn'
const SERVER_HINT = 'node server.mjs — github.com/milind-soni/writeback'
const GREETING_TEXT = "Write or sketch something — I'll answer on the canvas."
const SILENT_TEXT = `assistant offline — start the server: ${SERVER_HINT}`

const IDLE_MS = 2500
const EDIT_POLL_MS = 150
const FADE_IN_MS = 1200
const FADE_STAGGER_MS = 150
const SILENT_VISIBLE_MS = 6000
const SILENT_FADE_MS = 900
const GREETING_FADE_MS = 1400
const MAX_HISTORY = 40
const MAX_REPLY_SHAPES = 12
const MAX_TEXT_LEN = 500
const EXPORT_LONGEST_EDGE = 1600
// Headless Claude turns (cold start + reading the screenshot + drawing) can
// run well past a minute — match the companion server's own 180s ceiling.
const FETCH_TIMEOUT_MS = 180000

const HISTORY_SHAPE_ID = createShapeId('riddle-diary-history')

const VALID_COLORS = new Set([
	'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
	'orange', 'green', 'light-green', 'light-red', 'red', 'white',
])
const VALID_GEO = new Set([
	'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
	'octagon', 'star', 'rhombus', 'oval', 'trapezoid', 'arrow-right',
	'arrow-left', 'arrow-up', 'arrow-down', 'cloud', 'heart', 'x-box', 'check-box',
])
const VALID_SIZE = new Set(['s', 'm', 'l', 'xl'])

function isFiniteNum(n) {
	return typeof n === 'number' && Number.isFinite(n)
}
function clampStr(s, max) {
	if (typeof s !== 'string') return ''
	return s.length > max ? s.slice(0, max) : s
}
function safeColor(c) {
	return typeof c === 'string' && VALID_COLORS.has(c) ? c : 'black'
}
function safeGeo(g) {
	return typeof g === 'string' && VALID_GEO.has(g) ? g : 'rectangle'
}
function safeSize(s) {
	return VALID_SIZE.has(s) ? s : 'm'
}

/** @param {import('../.script-workspace/script-context').MainScriptContext} ctx */
export default function (ctx) {
	const { editor, helpers, signal } = ctx

	let destroyed = false
	let turnInFlight = false
	let idleTimer = null
	const pendingIds = new Set()
	let prevEditingId = editor.getEditingShapeId()

	// Recovered/derived state (survives a Reload Script mid-session).
	let greetingIds = editor
		.getCurrentPageShapes()
		.filter((s) => s.meta && s.meta.riddle === 'diary' && s.meta.greeting)
		.map((s) => s.id)

	// Clean up any stale "thinking" indicator left behind by a crash/reload.
	const staleIndicators = editor
		.getCurrentPageShapes()
		.filter((s) => s.meta && s.meta.riddle === 'diary' && s.meta.indicator)
		.map((s) => s.id)
	if (staleIndicators.length) {
		editor.run(() => editor.deleteShapes(staleIndicators), { history: 'ignore' })
	}

	// ---------- shape/state helpers ----------

	function isUserShape(shape) {
		return !!shape && !(shape.meta && shape.meta.riddle === 'diary')
	}

	function contentShapes() {
		// Everything except the hidden bookkeeping shape.
		return editor.getCurrentPageShapes().filter((s) => !(s.meta && s.meta.bookkeeping))
	}

	function unionBoundsForIds(ids) {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
		for (const id of ids) {
			const b = editor.getShapePageBounds(id)
			if (!b) continue
			minX = Math.min(minX, b.x)
			minY = Math.min(minY, b.y)
			maxX = Math.max(maxX, b.x + b.w)
			maxY = Math.max(maxY, b.y + b.h)
		}
		if (!Number.isFinite(minX)) return null
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
	}

	function extractShapeText(shape) {
		try {
			const rt = shape.props && shape.props.richText
			if (rt) {
				const t = helpers.richTextToPlainText(rt)
				return t && t.length ? t : null
			}
		} catch (e) {
			// ignore
		}
		return null
	}

	function extractUserText(ids) {
		const parts = []
		for (const id of ids) {
			const s = editor.getShape(id)
			if (!s) continue
			if (s.type === 'text' || s.type === 'note') {
				const t = extractShapeText(s)
				if (t) parts.push(t)
			}
		}
		return parts.length ? parts.join('\n').trim() : null
	}

	function buildShapesPayload() {
		return contentShapes().map((s) => {
			const b = editor.getShapePageBounds(s.id)
			return {
				id: s.id,
				type: s.type,
				x: s.x,
				y: s.y,
				w: b ? b.w : (s.props && s.props.w) || 0,
				h: b ? b.h : (s.props && s.props.h) || 0,
				text: extractShapeText(s),
			}
		})
	}

	async function exportScreenshot() {
		const ids = contentShapes().map((s) => s.id)
		if (!ids.length) return null
		const bounds = unionBoundsForIds(ids)
		const maxDim = bounds ? Math.max(bounds.w, bounds.h, 1) : EXPORT_LONGEST_EDGE
		const scale = Math.max(0.05, Math.min(3, EXPORT_LONGEST_EDGE / maxDim))
		try {
			const res = await editor.toImageDataUrl(ids, { format: 'jpeg', scale, background: true })
			return res.url
		} catch (e) {
			return null
		}
	}

	function readHistory() {
		const rec = editor.getShape(HISTORY_SHAPE_ID)
		if (!rec || !rec.meta || typeof rec.meta.history !== 'string') return []
		try {
			const arr = JSON.parse(rec.meta.history)
			return Array.isArray(arr) ? arr : []
		} catch (e) {
			return []
		}
	}

	function writeHistory(history) {
		const capped = history.slice(-MAX_HISTORY)
		const json = JSON.stringify(capped)
		editor.run(() => {
			if (editor.getShape(HISTORY_SHAPE_ID)) {
				editor.updateShape({
					id: HISTORY_SHAPE_ID,
					type: 'geo',
					meta: { riddle: 'diary', bookkeeping: true, history: json },
				})
			} else {
				editor.createShapes([
					{
						id: HISTORY_SHAPE_ID,
						type: 'geo',
						x: -10000,
						y: -10000,
						opacity: 0,
						isLocked: true,
						meta: { riddle: 'diary', bookkeeping: true, history: json },
						props: { geo: 'rectangle', w: 1, h: 1, fill: 'none', color: 'black' },
					},
				])
			}
		}, { history: 'ignore' })
	}

	function appendHistoryEntries(userText, replyText) {
		const history = readHistory()
		history.push({ role: 'writer', text: userText && userText.trim().length ? userText.trim() : '[a drawing]' })
		history.push({ role: 'diary', text: replyText && replyText.length ? replyText : '' })
		writeHistory(history)
	}

	// ---------- animation helpers (all writes kept out of undo history) ----------

	function animateOpacityCancellable(ids, { from, to, duration, state }) {
		return new Promise((resolve) => {
			const start = Date.now()
			function step() {
				if (destroyed) { resolve(); return }
				if (state && state.cancelled) { resolve(); return }
				const elapsed = Date.now() - start
				const t = Math.min(1, duration <= 0 ? 1 : elapsed / duration)
				const opacity = from + (to - from) * t
				const currentIds = ids.filter((id) => editor.getShape(id))
				if (currentIds.length) {
					editor.run(
						() => editor.updateShapes(currentIds.map((id) => ({ id, type: editor.getShape(id).type, opacity }))),
						{ history: 'ignore' }
					)
				}
				if (t >= 1) { resolve(); return }
				setTimeout(step, 40)
			}
			step()
		})
	}

	async function fadeOutAndDelete(ids, duration) {
		const valid = ids.filter((id) => editor.getShape(id))
		if (!valid.length) return
		await animateOpacityCancellable(valid, { from: 1, to: 0, duration })
		if (destroyed) return
		const stillThere = valid.filter((id) => editor.getShape(id))
		if (stillThere.length) editor.run(() => editor.deleteShapes(stillThere), { history: 'ignore' })
	}

	function createThinkingIndicator(bounds) {
		const id = createShapeId()
		const x = bounds ? bounds.x + bounds.w + 24 : 100
		const y = bounds ? bounds.y : 100
		editor.run(
			() =>
				editor.createShapes([
					{
						id,
						type: 'geo',
						x,
						y,
						opacity: 0.5,
						meta: { riddle: 'diary', indicator: true },
						props: { geo: 'ellipse', w: 16, h: 16, color: 'black', fill: 'solid', dash: 'solid' },
					},
				]),
			{ history: 'ignore' }
		)
		return id
	}

	function startPulse(id) {
		const start = Date.now()
		const period = 1000
		const iv = setInterval(() => {
			if (destroyed) { clearInterval(iv); return }
			if (!editor.getShape(id)) { clearInterval(iv); return }
			const t = ((Date.now() - start) % period) / period
			const opacity = 0.15 + 0.65 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2))
			editor.run(() => editor.updateShapes([{ id, type: 'geo', opacity }]), { history: 'ignore' })
		}, 60)
		return () => clearInterval(iv)
	}

	function removeIndicator(id) {
		if (editor.getShape(id)) editor.run(() => editor.deleteShapes([id]), { history: 'ignore' })
	}

	function showSilentMessage(bounds) {
		const id = createShapeId()
		const x = bounds ? bounds.x : 100
		const y = bounds ? bounds.y + bounds.h + 24 : 140
		editor.run(
			() =>
				editor.createShapes([
					{
						id,
						type: 'text',
						x,
						y,
						opacity: 0.55,
						meta: { riddle: 'diary', silent: true },
						props: { richText: toRichText(SILENT_TEXT), font: 'draw', size: 's', color: 'grey' },
					},
				]),
			{ history: 'ignore' }
		)
		setTimeout(() => {
			if (destroyed) return
			animateOpacityCancellable([id], { from: 0.55, to: 0, duration: SILENT_FADE_MS }).then(() => {
				if (destroyed) return
				if (editor.getShape(id)) editor.run(() => editor.deleteShapes([id]), { history: 'ignore' })
			})
		}, SILENT_VISIBLE_MS)
	}

	function ensureGreeting() {
		if (readHistory().length > 0) return
		const already = editor
			.getCurrentPageShapes()
			.some((s) => s.meta && s.meta.riddle === 'diary' && s.meta.greeting)
		if (already) return
		const bounds = unionBoundsForIds(contentShapes().map((s) => s.id))
		const id = createShapeId()
		const x = bounds ? bounds.x + bounds.w + 60 : 100
		const y = bounds ? bounds.y : 100
		editor.run(
			() =>
				editor.createShapes([
					{
						id,
						type: 'text',
						x,
						y,
						opacity: 0.03,
						meta: { riddle: 'diary', greeting: true },
						props: { richText: toRichText(GREETING_TEXT), font: 'draw', size: 'm', color: 'black' },
					},
				]),
			{ history: 'ignore' }
		)
		greetingIds = [id]
		animateOpacityCancellable([id], { from: 0.03, to: 1, duration: GREETING_FADE_MS })
	}

	// ---------- reply translation (simplified contract -> real shapes) ----------

	function candidateText(c) {
		try {
			if (c.props && c.props.richText) {
				const t = helpers.richTextToPlainText(c.props.richText)
				return t || ''
			}
		} catch (e) {
			// ignore
		}
		return ''
	}

	function translateReplyItem(item) {
		if (!item || typeof item !== 'object') return null
		try {
			const kind = item.kind
			if (kind === 'text') {
				if (!isFiniteNum(item.x) || !isFiniteNum(item.y) || typeof item.text !== 'string') return null
				return {
					id: createShapeId(),
					type: 'text',
					x: item.x,
					y: item.y,
					opacity: 0.05,
					meta: { riddle: 'diary', reply: true },
					props: {
						richText: toRichText(clampStr(item.text, MAX_TEXT_LEN)),
						font: 'draw',
						size: safeSize(item.size),
						color: safeColor(item.color),
					},
				}
			}
			if (kind === 'geo') {
				if (
					!isFiniteNum(item.x) || !isFiniteNum(item.y) ||
					!isFiniteNum(item.w) || !isFiniteNum(item.h) ||
					item.w <= 0 || item.h <= 0
				) return null
				const props = { geo: safeGeo(item.geo), w: item.w, h: item.h, font: 'draw', color: safeColor(item.color) }
				if (typeof item.text === 'string' && item.text.length) props.richText = toRichText(clampStr(item.text, MAX_TEXT_LEN))
				return {
					id: createShapeId(),
					type: 'geo',
					x: item.x,
					y: item.y,
					opacity: 0.05,
					meta: { riddle: 'diary', reply: true },
					props,
				}
			}
			if (kind === 'note') {
				if (!isFiniteNum(item.x) || !isFiniteNum(item.y) || typeof item.text !== 'string') return null
				return {
					id: createShapeId(),
					type: 'note',
					x: item.x,
					y: item.y,
					opacity: 0.05,
					meta: { riddle: 'diary', reply: true },
					props: {
						richText: toRichText(clampStr(item.text, MAX_TEXT_LEN)),
						font: 'draw',
						color: safeColor(item.color),
					},
				}
			}
			if (kind === 'line') {
				if (![item.x1, item.y1, item.x2, item.y2].every(isFiniteNum)) return null
				return {
					id: createShapeId(),
					type: 'line',
					x: 0,
					y: 0,
					opacity: 0.05,
					meta: { riddle: 'diary', reply: true },
					props: {
						color: safeColor(item.color),
						points: {
							a1: { id: 'a1', index: 'a1', x: item.x1, y: item.y1 },
							a2: { id: 'a2', index: 'a2', x: item.x2, y: item.y2 },
						},
					},
				}
			}
			if (kind === 'arrow') {
				if (![item.x1, item.y1, item.x2, item.y2].every(isFiniteNum)) return null
				const props = {
					color: safeColor(item.color),
					start: { x: item.x1, y: item.y1 },
					end: { x: item.x2, y: item.y2 },
				}
				if (typeof item.text === 'string' && item.text.length) props.richText = toRichText(clampStr(item.text, MAX_TEXT_LEN))
				// Decorative: reply arrows are not bound to other shapes.
				return {
					id: createShapeId(),
					type: 'arrow',
					x: 0,
					y: 0,
					opacity: 0.05,
					meta: { riddle: 'diary', reply: true, lintIgnore: ['friendless-arrow'] },
					props,
				}
			}
			if (kind === 'draw') {
				if (!Array.isArray(item.points) || item.points.length < 2) return null
				const pts = item.points
					.filter((p) => Array.isArray(p) && isFiniteNum(p[0]) && isFiniteNum(p[1]))
					.slice(0, 200)
				if (pts.length < 2) return null
				const [ox, oy] = pts[0]
				const legacy = [{ type: 'free', points: pts.map(([x, y]) => ({ x: x - ox, y: y - oy, z: 0.5 })) }]
				const segments = compressLegacySegments(legacy)
				return {
					id: createShapeId(),
					type: 'draw',
					x: ox,
					y: oy,
					opacity: 0.05,
					meta: { riddle: 'diary', reply: true },
					props: { segments, color: safeColor(item.color), isComplete: true },
				}
			}
		} catch (e) {
			return null
		}
		return null
	}

	async function createReplyShapesFadeIn(partials) {
		if (!partials.length) return []
		editor.run(() => editor.createShapes(partials), { history: 'ignore' })
		await Promise.all(
			partials.map(
				(p, i) =>
					new Promise((resolve) => {
						setTimeout(() => {
							if (destroyed) { resolve(); return }
							animateOpacityCancellable([p.id], { from: 0.05, to: 1, duration: FADE_IN_MS }).then(resolve)
						}, i * FADE_STAGGER_MS)
					})
			)
		)
		return partials.map((p) => p.id)
	}

	// ---------- network ----------

	async function postTurn(payload) {
		const controller = new AbortController()
		const onAbort = () => controller.abort()
		signal.addEventListener('abort', onAbort)
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
		try {
			const res = await fetch(SERVER_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal,
			})
			if (!res.ok) throw new Error('http ' + res.status)
			const json = await res.json()
			if (!json || !Array.isArray(json.shapes)) throw new Error('bad response shape')
			return json
		} finally {
			clearTimeout(timeout)
			signal.removeEventListener('abort', onAbort)
		}
	}

	// ---------- turn orchestration ----------

	async function runTurn(committedIds) {
		turnInFlight = true
		try {
			const bounds = unionBoundsForIds(committedIds) || { x: 0, y: 0, w: 100, h: 100 }
			const userText = extractUserText(committedIds)
			const payloadShapes = buildShapesPayload()
			const screenshotDataUrl = await exportScreenshot()
			const history = readHistory()
			const payload = {
				shapes: payloadShapes,
				userInput: { ids: committedIds, bounds, text: userText },
				screenshotDataUrl,
				history,
			}

			if (destroyed) return

			// Only the first-run greeting recedes; user ink and past replies stay.
			if (greetingIds.length) {
				const g = greetingIds
				greetingIds = []
				fadeOutAndDelete(g, GREETING_FADE_MS)
			}

			const indicatorId = createThinkingIndicator(bounds)
			const stopPulse = startPulse(indicatorId)

			let json = null
			try {
				json = await postTurn(payload)
			} catch (e) {
				json = null
			}

			stopPulse()
			removeIndicator(indicatorId)

			if (destroyed) return

			if (!json) {
				showSilentMessage(bounds)
			} else {
				const candidates = json.shapes
					.slice(0, MAX_REPLY_SHAPES * 2)
					.map(translateReplyItem)
					.filter(Boolean)
					.slice(0, MAX_REPLY_SHAPES)
				await createReplyShapesFadeIn(candidates)
				const replyText = candidates.map(candidateText).filter((t) => t.length).join(' ').trim()
				appendHistoryEntries(userText, replyText)
			}
		} finally {
			turnInFlight = false
		}
	}

	async function tryCommit() {
		if (turnInFlight || destroyed) return
		if (pendingIds.size === 0) return
		const editingId = editor.getEditingShapeId()
		const ids = []
		for (const id of pendingIds) {
			if (id === editingId) continue // still being edited; keep pending
			const s = editor.getShape(id)
			if (s && isUserShape(s)) ids.push(id)
		}
		if (!ids.length) return
		for (const id of ids) pendingIds.delete(id)
		await runTurn(ids)
	}

	function scheduleIdleCommit() {
		if (idleTimer) clearTimeout(idleTimer)
		idleTimer = setTimeout(() => {
			idleTimer = null
			if (destroyed) return
			tryCommit()
		}, IDLE_MS)
	}

	function handleChangedShape(shape) {
		if (!isUserShape(shape)) return false
		pendingIds.add(shape.id)
		const isTextOrNote = shape.type === 'text' || shape.type === 'note'
		const isBeingEdited = editor.getEditingShapeId() === shape.id
		if (isTextOrNote && isBeingEdited) return false
		return true
	}

	// ---------- input detection wiring ----------

	const stopStoreListen = editor.store.listen(
		(entry) => {
			if (destroyed || turnInFlight) return
			let sawIdleTrigger = false
			for (const id in entry.changes.added) {
				const rec = entry.changes.added[id]
				if (rec.typeName !== 'shape') continue
				if (handleChangedShape(rec)) sawIdleTrigger = true
			}
			for (const id in entry.changes.updated) {
				const to = entry.changes.updated[id][1]
				if (to.typeName !== 'shape') continue
				if (handleChangedShape(to)) sawIdleTrigger = true
			}
			if (sawIdleTrigger) scheduleIdleCommit()
		},
		{ source: 'user', scope: 'document' }
	)

	const pollInterval = setInterval(() => {
		if (destroyed) return
		const currentEditingId = editor.getEditingShapeId()
		if (!turnInFlight && prevEditingId && !currentEditingId) {
			const shape = editor.getShape(prevEditingId)
			if (shape && isUserShape(shape) && (shape.type === 'text' || shape.type === 'note')) {
				pendingIds.add(prevEditingId)
				if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
				tryCommit()
			}
		}
		prevEditingId = currentEditingId
	}, EDIT_POLL_MS)

	signal.addEventListener('abort', () => {
		destroyed = true
		stopStoreListen()
		clearInterval(pollInterval)
		if (idleTimer) clearTimeout(idleTimer)
	})

	ensureGreeting()
}
