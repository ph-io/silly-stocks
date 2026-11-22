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
import os from 'node:os'
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

// stdin "ignore", sonst wartet claude -p auf Eingabe. stdout als Buffer (Vorschau-JPEG ist binär).
function run(cmd, argv, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
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

// EXIF-Orientation (numerisch) -> Drehwinkel für sharp. Die eingebettete Vorschau ist ungedreht.
const ROTATE = { 3: 180, 6: 90, 8: 270 }

async function makeThumb(cr3, dest) {
    let jpg = await run('exiftool', ['-b', '-PreviewImage', cr3])
    if (!jpg.length) jpg = await run('exiftool', ['-b', '-JpgFromRaw', cr3])
    if (!jpg.length) throw new Error('keine eingebettete Vorschau gefunden')
    const [{ Orientation } = {}] = JSON.parse((await run('exiftool', ['-j', '-n', '-Orientation', cr3])).toString())
    await sharp(jpg)
        .rotate(ROTATE[Orientation] ?? 0)
        .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(dest)
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

function buildPrompt(thumbName, existing) {
    return `Lies die Bilddatei ./${thumbName}. Es ist ein Foto für eine Bildagentur (redaktionelle Nutzung) und zeigt einen Bildschirm, ein Gerät oder ein Objekt mit dem Logo einer App, Marke oder Firma.

1. Erkenne, welche App/Firma/Marke zu sehen ist. Wenn mehrere, dann in der Reihenfolge von links nach rechts.
2. Schreibe den Namen der App/Firma/Marke in die Bildunterschrift. Wenn mehrere, dann durch Komma getrennt.
3. Schreibe den gängigen Namen der App/Firma/Marke in die Keywords, sowie den offiziellen Namen und ggf. den Namen der Muttergesellschaft (falls zutreffend). Außerdem 1-6 Stichwörter, die die App/Firma/Marke mit allgemeinen Begriffen bschreibt – diese Stichwörter in Deutsch und Englisch hinzufügen.

3 Beispiele für die Bildunterschrift:
* Facebook, Instragram und SnapChat
* Anthropic
* ARD Mediathek

3 Beispiele für die Keywords:
* Facebook, Facebook Inc., Meta, Meta Platforms Inc., Social Media, Social Network
* YouTube, YouTube LLC, Alphabet, Alphabet Inc., Social Media, Social Network, Video-Streaming, Streaming
* ChatGPT, OpenAI, OpenAI, Inc., KI, Künstliche Intelligenz, AI, Artificial Intelligence

${
    existing
        ? `Vorhandene Metadaten dieser Datei (kann ein Dateiname wie "apple-11-dark" oder veraltet sein – nutze sie als Hinweis, aber vertraue dem Bild):\n${existing}`
        : 'Es gibt keine vorhandenen Metadaten.'
}

Antworte nur mit dem strukturierten Ergebnis.`
}

async function askClaude(tmpDir, thumbName, existing) {
    const out = await run(
        'claude',
        [
            '-p',
            buildPrompt(thumbName, existing),
            '--safe-mode', // keine Hooks/Plugins/CLAUDE.md des Nutzers – sauberer Output
            '--no-session-persistence',
            '--tools',
            'Read',
            '--allowedTools',
            'Read',
            '--output-format',
            'json',
            '--json-schema',
            JSON.stringify(SCHEMA),
        ],
        { cwd: tmpDir }
    )
    const res = JSON.parse(out.toString())
    if (res.is_error) throw new Error(`claude: ${res.result}`)
    return validate(res.structured_output)
}

// Vertrauensgrenze: nur sauberes Ergebnis wird geschrieben.
function validate(r) {
    const caption = typeof r?.caption === 'string' ? r.caption.trim() : ''
    const keywords = Array.isArray(r?.keywords)
        ? [
              ...new Set(
                  r.keywords
                      .filter((k) => typeof k === 'string')
                      .map((k) => k.trim())
                      .filter(Boolean)
              ),
          ]
        : []
    if (!caption) throw new Error(`leere Caption von Claude: ${JSON.stringify(r)}`)
    if (!keywords.length) throw new Error(`keine Keywords von Claude: ${JSON.stringify(r)}`)
    return { company: String(r.company ?? '').trim(), caption, keywords }
}

// Self-Check der Validierung bei jedem Start.
assert.deepEqual(validate({ company: 'X', caption: ' c ', keywords: [' a', 'a', 1, '', 'b'] }), {
    company: 'X',
    caption: 'c',
    keywords: ['a', 'b'],
})
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

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagger-'))
    const failed = []
    try {
        for (const [i, rel] of raws.entries()) {
            const tag = `[${i + 1}/${raws.length}] ${rel}`
            try {
                const sidecar = byLower.get(rel.replace(/\.cr3$/i, '.xmp').toLowerCase())
                const files = [rel, sidecar].filter(Boolean).map((f) => path.join(DIR, f))

                const thumbName = `thumb-${i}.jpg`
                await makeThumb(files[0], path.join(tmpDir, thumbName))
                const meta = await askClaude(tmpDir, thumbName, await readMeta(files))
                await writeMeta(files, meta)
                await fs.rm(path.join(tmpDir, thumbName), { force: true })

                console.log(`${tag}\n  ${meta.company}: ${meta.caption}\n  ${meta.keywords.join(', ')}`)
            } catch (e) {
                failed.push(rel)
                console.error(`${tag}\n  FEHLER: ${e.message}`)
            }
        }
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true })
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

