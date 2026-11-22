#!/usr/bin/env node
// tagger.mjs
//
// Geht über alle CR3-Dateien eines Ordners (samt Unterordnern), erzeugt aus der
// eingebetteten Vorschau ein Thumbnail (sharp), lässt Claude (claude CLI) die
// abgebildete App/Firma erkennen und schreibt die neue Caption und Keywords per
// exiftool in die CR3 und – falls vorhanden – in die XMP-Sidecar-Datei.
//
// Vorhandene Titel/Beschreibung/Keywords aus CR3 und XMP gehen als Hinweis in den Prompt.
//
// Voraussetzungen: Node.js 20+, exiftool (brew install exiftool), claude CLI (eingeloggt).
//
// Aufruf:
//   node tagger.mjs <ordner>
//   z. B. node tagger.mjs ingest

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const { positionals } = parseArgs({ allowPositionals: true })
if (!positionals[0]) {
    console.error('Aufruf: node tagger.mjs <ordner>')
    process.exit(1)
}
const DIR = path.resolve(positionals[0])
const THUMB_EDGE = 920
const MODEL = 'sonnet' // Alias (fable, opus, sonnet, haiku) oder volle Model-ID
const EFFORT = 'medium' // low, medium, high, xhigh, max

const SCHEMA = {
    type: 'object',
    properties: {
        company: { type: 'string' },
        caption: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
    },
    required: ['company', 'caption', 'keywords'],
    additionalProperties: false,
}

// ---------------------------------------------------------------- Hilfsfunktionen

// input wird auf stdin geschrieben, sonst stdin "ignore". stdout als Buffer (Vorschau-JPEG ist binär).
function run(cmd, argv, input) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, argv, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
        if (input !== undefined) p.stdin.end(input)
        const out = []
        let err = ''
        p.stdout.on('data', (d) => out.push(d))
        p.stderr.on('data', (d) => (err += d))
        p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${cmd} nicht gefunden (installiert?)`) : e))
        p.on('close', (code) => {
            const buf = Buffer.concat(out)
            code === 0 ? resolve(buf) : reject(new Error(`${cmd} exit ${code}: ${(err || buf.toString()).trim()}`))
        })
    })
}

// macOS-Systemsound (/System/Library/Sounds). Fehler egal, Sound ist nur Hinweis.
function playSound(name) {
    if (process.platform !== 'darwin') return Promise.resolve()
    return run('afplay', [`/System/Library/Sounds/${name}.aiff`]).catch(() => {})
}

// EXIF-Orientation (numerisch) -> Drehwinkel für sharp. Die eingebettete Vorschau ist ungedreht.
const ROTATE = { 3: 180, 6: 90, 8: 270 }

async function makeThumb(cr3) {
    let jpg = await run('exiftool', ['-b', '-PreviewImage', cr3])
    if (!jpg.length) jpg = await run('exiftool', ['-b', '-JpgFromRaw', cr3])
    if (!jpg.length) throw new Error('keine eingebettete Vorschau gefunden')
    const [{ Orientation } = {}] = JSON.parse((await run('exiftool', ['-j', '-n', '-Orientation', cr3])).toString())
    return sharp(jpg)
        .rotate(ROTATE[Orientation] ?? 0)
        .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
}

async function readMeta(files) {
    const rows = JSON.parse((await run('exiftool', ['-j', '-XMP-dc:Title', '-XMP-dc:Description', '-XMP-dc:Subject', ...files])).toString())
    const lines = []
    for (const r of rows) {
        const kw = [r.Subject].flat().filter(Boolean).join(', ')
        const parts = [r.Title && `Titel: ${r.Title}`, r.Description && `Beschreibung: ${r.Description}`, kw && `Keywords: ${kw}`].filter(Boolean)
        if (parts.length) lines.push(`${path.basename(r.SourceFile)}: ${parts.join(' | ')}`)
    }
    return lines.join('\n')
}

// Feste Regeln als System-Prompt: ersetzt den langen Claude-Code-Prompt und ist für alle Bilder gleich (Cache).
const SYSTEM_PROMPT = `Du verschlagwortest Fotos für eine Bildagentur (redaktionelle Nutzung). Jedes Foto zeigt einen Bildschirm, ein Gerät oder ein Objekt mit dem Logo einer App, Marke oder Firma.

1. Erkenne alle Apps/Firmen/Marken auf dem Bild. Reihenfolge: von links nach rechts, dann von oben nach unten.
2. Bildunterschrift: nur die Namen, wie sie gängig geschrieben werden. Mehrere durch Komma getrennt, die letzten beiden mit „und“.
3. Keywords, für jede erkannte App/Firma/Marke:
   - der gängige Name
   - der offizielle Firmenname, falls er abweicht
   - die Muttergesellschaft (gängiger und offizieller Name), falls es eine gibt
   - 1–6 allgemeine Begriffe für Branche bzw. Kategorie, auf Deutsch und Englisch. Den englischen Begriff nur ergänzen, wenn er ein anderes Wort ist (z. B. „Künstliche Intelligenz“ und „Artificial Intelligence“). Unterscheidet er sich nur durch Bindestrich, Leerzeichen oder Groß-/Kleinschreibung, ist er ein Duplikat.
   Keine Duplikate. Von Schreibvarianten nur die mit Bindestrich: „Online-Shop“, nicht zusätzlich „Online Shop“; „Shopping-App“, nicht zusätzlich „Shopping App“. Keine Kommas innerhalb eines Keywords. 
   Verwende keine Stichwörter wie "App", "Icon" oder "Logo", wenn sie nicht Teil des Namens der App/Firma/Marke sind.

Erkennst du ein Logo nicht sicher, rate nicht. Lass Bildunterschrift und Keywords dann leer.

Beispiele (Bildunterschrift → Keywords):
- Claude → Claude, Anthropic, Anthropic PBC, KI, Künstliche Intelligenz, AI, Artificial Intelligence
- YouTube → YouTube, YouTube LLC, Alphabet, Alphabet Inc., Video-Streaming, Streaming, Soziale Medien, Social Media
- Facebook, Instagram und Snapchat → Facebook, Instagram, Meta, Meta Platforms Inc., Snapchat, Snap, Snap Inc., Soziales Netzwerk, Social Network, Soziale Medien, Social Media

Antworte nur mit dem strukturierten Ergebnis.`

function buildPrompt(existing) {
    return existing
        ? `Vorhandene Metadaten dieser Datei (kann ein Dateiname wie "apple-11-dark" oder veraltet sein – nutze sie als Hinweis, aber vertraue dem Bild):\n${existing}`
        : 'Es gibt keine vorhandenen Metadaten.'
}

// Bild geht inline per stream-json mit, ohne Read-Tool: spart einen Turn und den Tool-Overhead.
async function askClaude(thumb, existing) {
    const msg = {
        type: 'user',
        message: {
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumb.toString('base64') } },
                { type: 'text', text: buildPrompt(existing) },
            ],
        },
    }
    const out = await run(
        'claude',
        [
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose', // von der CLI für stream-json-Ausgabe verlangt
            '--system-prompt',
            SYSTEM_PROMPT,
            '--safe-mode', // keine Hooks/Plugins/CLAUDE.md des Nutzers – sauberer Output
            '--no-session-persistence',
            '--model',
            MODEL,
            '--effort',
            EFFORT,
            '--tools',
            '',
            '--json-schema',
            JSON.stringify(SCHEMA),
        ],
        JSON.stringify(msg) + '\n'
    )
    const res = out
        .toString()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .findLast((e) => e.type === 'result')
    if (!res) throw new Error('claude: kein Ergebnis in der Ausgabe')
    if (res.is_error) throw new Error(`claude: ${res.result}`)
    return validate(res.structured_output)
}

// Vertrauensgrenze: nur sauberes Ergebnis wird geschrieben.
function validate(r) {
    const caption = typeof r?.caption === 'string' ? r.caption.trim() : ''
    // Schreibvarianten (Bindestrich/Leerzeichen/Groß-klein) zusammenfassen, Bindestrich-Variante gewinnt.
    const byKey = new Map()
    for (const k of Array.isArray(r?.keywords) ? r.keywords : []) {
        if (typeof k !== 'string' || !k.trim()) continue
        const kw = k.trim()
        const key = kw.toLowerCase().replace(/[\s-]+/g, '')
        const prev = byKey.get(key)
        if (prev === undefined || (!prev.includes('-') && kw.includes('-'))) byKey.set(key, kw)
    }
    const keywords = [...byKey.values()]
    if (!caption) throw Object.assign(new Error(`leere Caption von Claude: ${JSON.stringify(r)}`), { noData: true })
    if (!keywords.length) throw Object.assign(new Error(`keine Keywords von Claude: ${JSON.stringify(r)}`), { noData: true })
    return { company: String(r.company ?? '').trim(), caption, keywords }
}

// Self-Check der Validierung bei jedem Start.
assert.deepEqual(validate({ company: 'X', caption: ' c ', keywords: [' a', 'a', 1, '', 'b'] }), {
    company: 'X',
    caption: 'c',
    keywords: ['a', 'b'],
})
assert.deepEqual(validate({ caption: 'c', keywords: ['Online Shop', 'Shopping-App', 'Online-Shop', 'shopping app', 'Social Media'] }).keywords, [
    'Online-Shop',
    'Shopping-App',
    'Social Media',
])
assert.throws(() => validate({ caption: ' ', keywords: ['a'] }))
assert.throws(() => validate({ caption: 'c', keywords: [] }))
assert.throws(() => validate(undefined))

async function writeMeta(files, { caption, keywords }) {
    await run('exiftool', [
        '-overwrite_original',
        '-m',
        `-XMP-dc:Title=${caption}`,
        `-XMP-dc:Description=${caption}`,
        // '-XMP-dc:Subject=', // alte Keywords ersetzen statt anhängen
        ...keywords.map((k) => `-XMP-dc:Subject=${k}`),
        ...files,
    ])
}

// ---------------------------------------------------------------- Ablauf

async function main() {
    const all = (await fs.readdir(DIR, { recursive: true })).sort()
    const byLower = new Map(all.map((f) => [f.toLowerCase(), f]))
    const raws = all.filter((f) => /\.cr3$/i.test(f))
    if (!raws.length) throw new Error(`Keine CR3-Dateien in ${DIR}`)

    const failed = []
    for (const [i, rel] of raws.entries()) {
        const tag = `[${i + 1}/${raws.length}] ${rel}`
        try {
            const sidecar = byLower.get(rel.replace(/\.cr3$/i, '.xmp').toLowerCase())
            const files = [rel, sidecar].filter(Boolean).map((f) => path.join(DIR, f))

            const meta = await askClaude(await makeThumb(files[0]), await readMeta(files))
            await writeMeta(files, meta)

            console.log(`${tag}\n  ${meta.company}: ${meta.caption}\n  ${meta.keywords.join(', ')}`)
        } catch (e) {
            failed.push(rel)
            console.error(`${tag}\n  FEHLER: ${e.message}`)
            if (e.noData) playSound('Basso') // nicht awaiten, nächste Datei startet sofort
        }
    }

    console.log(`\nFertig: ${raws.length - failed.length} ok, ${failed.length} Fehler.`)
    if (failed.length) {
        console.log(failed.map((f) => `  ${f}`).join('\n'))
        process.exitCode = 1
    }
}

main().catch((e) => {
    console.error(e.message)
    process.exit(1)
})

