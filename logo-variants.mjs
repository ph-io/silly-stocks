#!/usr/bin/env node
/**
 * logo-variants.mjs
 *
 * Für jedes SVG im Eingabeordner (rekursiv, Standard logos/src):
 *   1. Dark-Version: Gibt es <name>-dark.svg, wird sie unverändert verwendet.
 *      Sonst wird sie aus <name>.svg erzeugt: Logofarben per Helligkeitsumkehr
 *      (HSL: L' = 1 - L, Farbton und Sättigung bleiben) und als <name>-dark.svg
 *      im Eingabeordner gespeichert.
 *   2. Erst dann Zeichenfläche auf die Bildschirmauflösung des iPhones erweitern
 *      (--width x --height, Standard 1206x2622 wie die Screenshots) und das Logo
 *      so skalieren, dass seine längste Seite --logo px misst (Standard 8/9 der
 *      Breite, also 1072 px; entspricht dem bisherigen 2000 auf 2250), in zwei Layouts:
 *        centered: Logo in der Mitte
 *        top:      Logo oben (Abstand = seitlicher Rand bei voller Breite), Fläche nach unten erweitert
 *        rotated:  Logo um 90° im Uhrzeigersinn gedreht, zentriert, füllt 75 % des Formats
 *                  (Breite oder Höhe, je nachdem was zuerst erreicht wird; --logo gilt hier nicht)
 *      Hintergrund weiß (<name>.svg) bzw. schwarz (<name>-dark.svg).
 *   3. Alle erzeugten SVGs als PNG rendern.
 *
 * Aufruf:
 *   node logo-variants.mjs [eingabeordner] [ausgabeordner] [--width 1206] [--height 2622] [--logo 1072]
 *
 * Ausgabe (Standard logos/output, d. h. <eingabeordner>/../output):
 *   <ausgabeordner>/svg/<centered|top|rotated>/<unterordner>/<name>.svg|<name>-dark.svg
 *   <ausgabeordner>/png/<centered|top|rotated>/<unterordner>/<name>.png|<name>-dark.png
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { parse as parseColor, converter, formatHex, formatRgb } from 'culori'

const toHsl = converter('hsl')

// ---------------------------------------------------------------- CLI

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        // Bildschirmauflösung des iPhones in Pixeln (iPhone-Screenshot = Maßstab)
        width: { type: 'string', default: '1206' },
        height: { type: 'string', default: '2622' },
        // Längste Logoseite in px; ohne Angabe 8/9 der Breite
        logo: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
    },
})

if (opts.help) {
    console.log('Aufruf: node logo-variants.mjs [eingabeordner=logos/src] [ausgabeordner=logos/output] [--width 1206] [--height 2622] [--logo 1072]')
    process.exit(0)
}

const INPUT_DIR = path.resolve(positionals[0] ?? fileURLToPath(new URL('logos/src', import.meta.url)))
const OUTPUT_DIR = path.resolve(positionals[1] ?? path.join(INPUT_DIR, '..', 'output'))
const DARK_SUFFIX = '-dark'
const CANVAS_W = Number(opts.width)
const CANVAS_H = Number(opts.height)
const LOGO_PX = opts.logo ? Number(opts.logo) : Math.round((CANVAS_W * 8) / 9)

if (!(CANVAS_W > 0 && CANVAS_H > 0)) throw new Error(`--width und --height müssen > 0 sein`)

if (!(LOGO_PX > 0)) throw new Error(`--logo muss > 0 sein (ist: ${opts.logo})`)
if (!(CANVAS_W >= LOGO_PX)) throw new Error(`Breite (${CANVAS_W}) muss >= --logo (${LOGO_PX}) sein`)

const LAYOUTS = ['centered', 'top', 'rotated']
// Anteil von Breite und Höhe, den das gedrehte Logo bei "rotated" höchstens füllt
const ROTATED_FILL = 0.75
// Abstand oben bei "top" = seitlicher Rand eines Logos in voller Breite
const TOP_MARGIN_PX = (CANVAS_W - LOGO_PX) / 2

const SVG_OUT = path.join(OUTPUT_DIR, 'svg')
const PNG_OUT = path.join(OUTPUT_DIR, 'png')

// ---------------------------------------------------------------- Hilfsfunktionen

async function findSvgs(dir) {
    const out = []
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (full === OUTPUT_DIR) continue // Ausgabe nicht erneut verarbeiten
            out.push(...(await findSvgs(full)))
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
            out.push(full)
        }
    }
    return out.sort()
}

/** Öffnendes Root-<svg>-Tag finden (überspringt XML-Deklaration, Kommentare, DOCTYPE). */
function findRootTag(svg) {
    const m = /<svg\b[^>]*>/i.exec(svg)
    if (!m) throw new Error('kein <svg>-Element gefunden')
    if (m[0].endsWith('/>')) throw new Error('leeres <svg/>-Element')
    return { tag: m[0], start: m.index, end: m.index + m[0].length }
}

function getAttr(tag, name) {
    const m = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'is').exec(tag)
    return m ? m[2] : null
}

function setAttr(tag, name, value) {
    const re = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, 'is')
    if (re.test(tag)) return tag.replace(re, `$1"${value}"`)
    return tag.replace(/^<svg\b/i, `<svg ${name}="${value}"`)
}

function removeAttr(tag, name) {
    return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'is'), '')
}

/** "200", "200px", "5.5mm" -> { num, unit }; "100%" oder leer -> null */
function parseLength(value) {
    if (value == null) return null
    const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(value)
    return m ? { num: Number(m[1]), unit: m[2] } : null
}

const fmt = (n) => String(Math.round(n * 1e6) / 1e6)

// ---------------------------------------------------------------- Schritt 2

function expandWithBackground(svg, color, layout) {
    const root = findRootTag(svg)
    let tag = root.tag

    const widthAttr = parseLength(getAttr(tag, 'width'))
    const heightAttr = parseLength(getAttr(tag, 'height'))

    let vb = getAttr(tag, 'viewBox')
    let x, y, w, h
    if (vb) {
        ;[x, y, w, h] = vb
            .trim()
            .split(/[\s,]+/)
            .map(Number)
    } else if (widthAttr && heightAttr) {
        ;[x, y, w, h] = [0, 0, widthAttr.num, heightAttr.num]
    } else {
        throw new Error('weder viewBox noch absolute width/height vorhanden')
    }
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
        throw new Error(`ungültige viewBox: "${vb}"`)
    }

    // Bildschirmfläche: längste Logoseite entspricht LOGO_PX, Logo horizontal zentriert,
    // vertikal zentriert ("centered") oder TOP_MARGIN_PX unter der Oberkante ("top")
    // "rotated": um 90° im Uhrzeigersinn gedreht (Breite/Höhe getauscht), zentriert,
    // eingepasst auf ROTATED_FILL der Bildschirmbreite und -höhe
    const unitsPerPx = layout === 'rotated' ? Math.max(h / (CANVAS_W * ROTATED_FILL), w / (CANVAS_H * ROTATED_FILL)) : Math.max(w, h) / LOGO_PX
    const nw = CANVAS_W * unitsPerPx,
        nh = CANVAS_H * unitsPerPx
    const nx = x + w / 2 - nw / 2,
        ny = layout === 'top' ? y - TOP_MARGIN_PX * unitsPerPx : y + h / 2 - nh / 2

    let body = svg.slice(root.end)
    if (layout === 'rotated') {
        const close = body.toLowerCase().lastIndexOf('</svg>')
        if (close < 0) throw new Error('kein schließendes </svg> gefunden')
        body = `<g transform="rotate(90 ${fmt(x + w / 2)} ${fmt(y + h / 2)})">` + body.slice(0, close) + '</g>' + body.slice(close)
    }

    tag = setAttr(tag, 'viewBox', `${fmt(nx)} ${fmt(ny)} ${fmt(nw)} ${fmt(nh)}`)
    tag = setAttr(tag, 'width', fmt(CANVAS_W))
    tag = setAttr(tag, 'height', fmt(CANVAS_H))

    // Inline-Style schlägt Stylesheet-Regeln wie "rect { fill: … }"
    const bg = `<rect data-logo-bg="1" x="${fmt(nx)}" y="${fmt(ny)}" width="${fmt(nw)}" height="${fmt(nh)}" ` + `style="fill:${color};stroke:none"/>`

    return svg.slice(0, root.start) + tag + bg + body
}

// ---------------------------------------------------------------- Schritt 1

/** Helligkeit umkehren, Farbton/Sättigung/Alpha behalten. */
function invertLightness(token) {
    const c = parseColor(token)
    if (!c) return token // none, currentColor, inherit, …
    if (c.alpha === 0) return token // transparent bleibt transparent
    const hsl = toHsl(c)
    hsl.l = 1 - (hsl.l ?? 0)
    return hsl.alpha !== undefined && hsl.alpha < 1 ? formatRgb(hsl) : formatHex(hsl)
}

/** Alle Farb-Tokens in einem Wert umrechnen; url(#…) bleibt unangetastet. */
function convertColorValue(value) {
    return value.replace(/url\([^)]*\)|#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)|\b[a-z]+\b/gi, (tok) =>
        tok.toLowerCase().startsWith('url(') ? tok : invertLightness(tok)
    )
}

const COLOR_PROPS = 'fill|stroke|stop-color|flood-color|lighting-color|solid-color|color'

const ATTR_RE = new RegExp(`(?<![\\w-])(${COLOR_PROPS})(\\s*=\\s*)(["'])(.*?)\\3`, 'gis')
const CSS_RE = new RegExp(`(?<![\\w-])(${COLOR_PROPS}|background-color|background)(\\s*:\\s*)([^;}]+)`, 'gi')

function convertCss(css) {
    return css.replace(CSS_RE, (_, prop, sep, val) => prop + sep + convertColorValue(val))
}

function convertMarkup(markup) {
    return (
        markup
            // <style>-Blöcke
            .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => open + convertCss(css) + close)
            // style="…"
            .replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gis, (_, pre, q, css) => `${pre}${q}${convertCss(css)}${q}`)
            // Präsentationsattribute fill="…", stroke="…", …
            .replace(ATTR_RE, (_, prop, eq, q, val) => `${prop}${eq}${q}${convertColorValue(val)}${q}`)
    )
}

function toDark(srcSvg) {
    // Masken arbeiten mit Luminanz (weiß = sichtbar) und dürfen nicht invertiert werden.
    const parts = srcSvg.split(/(<mask\b[\s\S]*?<\/mask>)/i)
    let out = parts
        .map((part, i) => {
            if (i % 2 === 0) return convertMarkup(part)
            // Maskeninhalt erbt sonst gleich die neue weiße Standardfüllung vom Root
            return part.replace(/^<mask\b[^>]*>/i, (open) => {
                let o = open
                if (!/\sfill\s*=/.test(o)) o = o.replace(/^<mask\b/i, '<mask fill="#000000"')
                if (!/\scolor\s*=/.test(o)) o = o.replace(/^<mask\b/i, '<mask color="#000000"')
                return o
            })
        })
        .join('')

    // Standardfüllung (schwarz) und currentColor (schwarz) explizit auf weiß setzen
    const root = findRootTag(out)
    let tag = root.tag
    const rootStyle = getAttr(tag, 'style') ?? ''
    if (getAttr(tag, 'fill') == null && !/(?<![\w-])fill\s*:/.test(rootStyle)) tag = setAttr(tag, 'fill', '#ffffff')
    if (getAttr(tag, 'color') == null && !/(?<![\w-])color\s*:/.test(rootStyle)) tag = setAttr(tag, 'color', '#ffffff')
    return out.slice(0, root.start) + tag + out.slice(root.end)
}

// ---------------------------------------------------------------- Schritt 3

function renderPng(svg) {
    // Hinweis: Die Option resourcesDir hebelt in resvg-js 2.6 fitTo aus, daher nicht gesetzt.
    const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: CANVAS_W },
        font: { loadSystemFonts: true },
    })
    return resvg.render().asPng()
}

// ---------------------------------------------------------------- Ablauf

const files = await findSvgs(INPUT_DIR)
if (files.length === 0) {
    console.log(`Keine SVG-Dateien in ${INPUT_DIR} gefunden.`)
    process.exit(0)
}

console.log(`${files.length} SVG(s) gefunden. Logo ${LOGO_PX} px auf ${CANVAS_W}x${CANVAS_H} px.\n`)

const generated = [] // Pfade der neuen SVGs
let failed = 0

const fileSet = new Set(files)

async function writeExpanded(base, svg, bgColor) {
    for (const layout of LAYOUTS) {
        const outPath = path.join(SVG_OUT, layout, `${base}.svg`)
        await fs.mkdir(path.dirname(outPath), { recursive: true })
        await fs.writeFile(outPath, expandWithBackground(svg, bgColor, layout))
        generated.push(outPath)
    }
}

// Schritte 1 + 2
for (const file of files) {
    const rel = path.relative(INPUT_DIR, file)
    const ext = path.extname(rel)
    const base = rel.slice(0, -ext.length)
    try {
        const src = await fs.readFile(file, 'utf8')

        // Eigene Dark-Version aus src: nur erweitern, Farben bleiben
        if (base.endsWith(DARK_SUFFIX)) {
            await writeExpanded(base, src, '#000000')
            console.log(`  SVG  ${rel}`)
            continue
        }

        // Schritt 1: Dark-Version erzeugen, falls keine eigene existiert (vor dem Erweitern)
        const hasOwnDark = fileSet.has(path.join(INPUT_DIR, base + DARK_SUFFIX + ext))
        let dark = null
        if (!hasOwnDark) {
            if (/<image\b/i.test(src)) {
                console.warn(`  Hinweis ${rel}: enthält Rastergrafik (<image>), deren Farben werden nicht umgerechnet.`)
            }
            dark = toDark(src)
            // Unerweitert neben dem Original ablegen; ab dem nächsten Lauf gilt sie als eigene Dark-Version.
            // 'wx': niemals eine vorhandene Datei überschreiben
            await fs.writeFile(path.join(INPUT_DIR, base + DARK_SUFFIX + ext), dark, {
                flag: 'wx',
            })
        }

        // Schritt 2: erweitern und speichern
        await writeExpanded(base, src, '#ffffff')
        if (dark) await writeExpanded(base + DARK_SUFFIX, dark, '#000000')
        console.log(`  SVG  ${rel}${dark ? ` (+ ${DARK_SUFFIX} erzeugt)` : ''}`)
    } catch (err) {
        failed++
        console.error(`  FEHLER ${rel}: ${err.message}`)
    }
}

// Schritt 3: Lauf über alle neuen SVGs
console.log('')
for (const svgPath of generated) {
    const rel = path.relative(SVG_OUT, svgPath)
    try {
        const png = renderPng(await fs.readFile(svgPath, 'utf8'))
        const pngPath = path.join(PNG_OUT, rel.replace(/\.svg$/i, '.png'))
        await fs.mkdir(path.dirname(pngPath), { recursive: true })
        await fs.writeFile(pngPath, png)
        console.log(`  PNG  ${rel.replace(/\.svg$/i, '.png')}`)
    } catch (err) {
        failed++
        console.error(`  FEHLER PNG ${rel}: ${err.message}`)
    }
}

console.log(`\nFertig. Ausgabe: ${OUTPUT_DIR}${failed ? ` (${failed} Fehler)` : ''}`)
process.exit(failed ? 1 : 0)

