#!/usr/bin/env node
// web-shooter.mjs
//
// Öffnet Websites nacheinander in Safari, sucht das Logo der Seite und schiebt
// das Safari-Fenster so, dass der Mittelpunkt des Logos genau in der Mitte des
// Bildschirms liegt. Dann löst die Kamera per gphoto2 aus, die RAW-Datei wird
// fortlaufend nummeriert (z. B. 0001.CR3) geladen und eine XMP-Datei geschrieben
// (Titel = Name, Beschreibung = Domain und Name, Stichwörter = Keywords, dc:source = URL).
//
// Ablauf pro Website: hell schalten (System im Light Mode, weißer Hintergrund, alle
// Apps außer Safari ausgeblendet, Dock und Menüleiste automatisch ausblenden),
// laden, Cookie-Banner wegklicken, Logo finden, Fenster platzieren. Dann auf
// Enter warten (Banner ggf. von Hand wegklicken), neu messen und auslösen.
// Danach dunkel schalten (Dark Mode, schwarzer Hintergrund), neu messen und ein
// zweites Mal auslösen. Am Ende werden alle Einstellungen zurückgesetzt.
//
// Voraussetzungen: Node.js 20+, gphoto2 (brew install gphoto2),
// optional exiftool (brew install exiftool) für --embed.
// Einmalig in Safari: Entwickler-Einstellungen -> "JavaScript von Apple Events erlauben".
// Für den pixelgenauen Mittelpunkt: Bildschirmaufnahme für VS Code/Terminal erlauben.
// Beim ersten Lauf erlauben, dass VS Code/Terminal Safari und System Events steuert.
// Safari-Zoom 100 %, Seitenleiste und Statusleiste aus, kein Vollbild.
//
// Aufruf:
//   node web-shooter.mjs [csv-datei]          (Standard: urls.csv)
//
// Die CSV-Datei hat pro Zeile: Domain;Name;Keywords;Status
//   Domain   ohne http/s, ohne www., ohne Pfad (geöffnet wird https://<domain>)
//   Keywords Komma-getrennte Stichwörter
//   Status   Datum der letzten Aufnahme. Das Script trägt es ein, sobald alle
//            Modi einer Website durch sind. Zeilen mit Status werden übersprungen.
// Kopfzeile, leere Zeilen und Zeilen mit # werden ignoriert. Zum Fortsetzen
// nach einem Abbruch einfach neu starten.
//
// Optionen:
//   --out <dir>       Zielordner für die Kameradateien                   [./ingest]
//   --shots <n>       Aufnahmen pro URL und Modus (hell/dunkel)            [1]
//   --settle <ms>     Wartezeit nach dem Laden der Seite                   [1500]
//   --window <WxH>    Größe des Safari-Fensters in Punkten                 [1200x900]
//   --display <n>     Bildschirm, auf dem das Logo mittig stehen soll      [1 = Hauptbildschirm]
//   --light           Nur das helle Foto
//   --dark            Nur das dunkle Foto (ohne --light/--dark: beide)
//   --embed           XMP per exiftool in die CR3 schreiben statt Sidecar-Datei
//   --dry-run         Ohne Kamera: nur Safari und Platzierung durchtesten
//   --no-pause        Nicht vor jeder Aufnahme auf Enter warten

import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: 'string', default: './ingest' },
        shots: { type: 'string', default: '1' },
        settle: { type: 'string', default: '1500' },
        window: { type: 'string', default: '1200x900' },
        display: { type: 'string', default: '1' },
        light: { type: 'boolean', default: false },
        dark: { type: 'boolean', default: false },
        embed: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'no-pause': { type: 'boolean', default: false },
    },
})

const CSV_FILE = path.resolve(positionals[0] ?? 'urls.csv')
const OUT_DIR = path.resolve(args.out)
const SHOTS = Math.max(1, Number(args.shots))
const SETTLE_MS = Math.max(0, Number(args.settle))
const [WIN_W, WIN_H] = args.window.split('x').map(Number)
const DISPLAY = Number(args.display)
const DRY = args['dry-run']
const PAUSE = !args['no-pause']
// Ohne --light/--dark beide Modi, sonst nur die angegebenen.
const MODES = args.light || args.dark ? [args.light && 'hell', args.dark && 'dunkel'].filter(Boolean) : ['hell', 'dunkel']
const LOAD_TIMEOUT_MS = 30_000
const IMAGE_WAIT_MS = 5_000 // Seite fertig, nur Bilder fehlen noch
const CAPTURE_ATTEMPTS = 3
const PLACE_ATTEMPTS = 8
const TOLERANCE_PT = 0.5 // Fensterposition geht nur in ganzen Punkten, genauer geht es nicht
if (!(WIN_W > 0 && WIN_H > 0)) throw new Error(`--window erwartet BREITExHÖHE, z. B. 1200x900, nicht "${args.window}"`)

// ---------------------------------------------------------------- Hilfsfunktionen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, argv) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        p.stdout.on('data', (d) => (out += d))
        p.stderr.on('data', (d) => (err += d))
        p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${cmd} nicht gefunden (installiert?)`) : e))
        p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} beendet mit Code ${code}: ${(err || out).trim()}`))))
    })
}

// macOS-Systemsound (/System/Library/Sounds). Fehler egal, Sound ist nur Hinweis.
function playSound(name) {
    if (process.platform !== 'darwin') return Promise.resolve()
    return run('afplay', [`/System/Library/Sounds/${name}.aiff`]).catch(() => {})
}

// Pro Zeile Domain;Name;Keywords;Status. line = Zeilenindex für withStatus.
// shortcut: einfaches split(';') ohne Felder in Anführungszeichen, Semikolons in Name oder Keywords gehen nicht.
function parseSites(text) {
    const sites = []
    text.split(/\r?\n/).forEach((raw, line) => {
        const f = raw
            .replace(/^﻿/, '') // BOM, schreiben Excel und Numbers
            .split(';')
            .map((s) => s.trim())
        if (!f[0] || f[0].startsWith('#') || f[0].toLowerCase() === 'domain') return
        const where = `Zeile ${line + 1} in ${CSV_FILE}`
        if (f.length > 4 || !f[1] || raw.includes('"')) throw new Error(`${where}: erwartet Domain;Name;Keywords;Status ohne Anführungszeichen, nicht "${raw}"`)
        // Falls doch Schema, www. oder Pfad drinstehen: abschneiden.
        const domain = f[0]
            .replace(/^https?:\/\//i, '')
            .replace(/^www\./i, '')
            .split(/[/?#]/)[0]
            .toLowerCase()
        let url
        try {
            url = new URL(`https://${domain}`).href
        } catch {
            throw new Error(`${where}: keine gültige Domain: ${f[0]}`)
        }
        const keywords = (f[2] ?? '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        sites.push({ line, domain, url, name: f[1], keywords, status: f[3] ?? '' })
    })
    return sites
}

// Setzt date als Status (4. Feld) in allen Zeilen mit dieser Domain, alle anderen Zeilen bleiben gleich.
function withStatus(text, domain, date) {
    const lines = text.split(/\r?\n/)
    for (const s of parseSites(text)) {
        if (s.domain !== domain) continue
        const f = lines[s.line].split(';')
        f[3] = date
        lines[s.line] = f.join(';')
    }
    return lines.join(text.includes('\r\n') ? '\r\n' : '\n')
}

assert.deepEqual(parseSites('﻿Domain;Name;Keywords;Status\r\n# Kommentar\r\n\r\nhttps://www.otto.de/shop;OTTO; Shop, Versand ,;\r\ncisco.com;Cisco;;2026-11-24\r\n'), [
    { line: 3, domain: 'otto.de', url: 'https://otto.de/', name: 'OTTO', keywords: ['Shop', 'Versand'], status: '' },
    { line: 4, domain: 'cisco.com', url: 'https://cisco.com/', name: 'Cisco', keywords: [], status: '2026-11-24' },
])
assert.throws(() => parseSites('github.com')) // Name fehlt
assert.throws(() => parseSites('https://;Leer'))
assert.equal(withStatus('Domain;Name\nwww.otto.de;OTTO\nzdf.de;ZDF;;\n', 'otto.de', '2026-11-24'), 'Domain;Name\nwww.otto.de;OTTO;;2026-11-24\nzdf.de;ZDF;;\n')
assert.equal(withStatus('﻿a.de;A;x;alt\r\n', 'a.de', 'neu'), '﻿a.de;A;x;neu\r\n')

// Gruppen von Zeilen mit derselben Domain. Zeilen mit Status zählen mit, weil saveStatus alle Zeilen einer Domain setzt.
function duplicates(rows) {
    const byDomain = new Map()
    for (const r of rows) byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r])
    return [...byDomain.values()].filter((g) => g.length > 1)
}

assert.deepEqual(
    duplicates(parseSites('a.de;A\nb.de;B\nhttps://www.a.de/x;A2;;2026-11-24\n')).map((g) => g.map((r) => r.line)),
    [[0, 2]]
)

async function saveStatus(domain) {
    const date = new Date().toLocaleDateString('sv-SE') // lokales Datum als JJJJ-MM-TT
    // Neu einlesen, damit Änderungen an der Datei während des Laufs erhalten bleiben.
    const text = withStatus(await fs.readFile(CSV_FILE, 'utf8'), domain, date)
    await fs.writeFile(`${CSV_FILE}.tmp`, text, 'utf8')
    await fs.rename(`${CSV_FILE}.tmp`, CSV_FILE)
}

// ---------------------------------------------------------------- Safari per JXA

// JavaScript for Automation. Werte gehen als argv rein, so braucht nichts escaped zu werden.
async function jxa(script, ...argv) {
    // "--", sonst hält osascript negative Zahlen wie -964 für Optionen
    const { out } = await run('osascript', ['-l', 'JavaScript', '-e', script, '--', ...argv.map(String)])
    return out.trim()
}

// Führt JS im vorderen Safari-Tab aus. Das JS muss einen JSON-String liefern.
// Fensterposition kommt gleich mit, damit beides aus demselben Moment stammt.
const PAGE_JXA = `function run([js]) {
  const s = Application('Safari'), w = s.windows[0]
  const r = s.doJavaScript(js, { in: w.currentTab })
  return JSON.stringify({ r: r ? JSON.parse(r) : null, bounds: w.bounds() })
}`
async function page(fn, ...fnArgs) {
    const js = `(${fn})(${fnArgs.map((a) => JSON.stringify(a)).join(',')})`
    return JSON.parse(await jxa(PAGE_JXA, js))
}

const setUrl = (url) => jxa(`function run([u]) { Application('Safari').windows[0].currentTab.url = u }`, url)

const activate = (app) => jxa(`function run([a]) { Application(a).activate() }`, app)

const moveWindow = (dx, dy) =>
    jxa(
        `function run([dx, dy]) {
  const w = Application('Safari').windows[0], b = w.bounds()
  w.bounds = { x: b.x + Number(dx), y: b.y + Number(dy), width: b.width, height: b.height }
}`,
        dx,
        dy
    )

// Safari starten, Fenster sicherstellen, auf den Zielbildschirm setzen und Größe festlegen.
// Die Größe bleibt danach fest: ein Resize würde das Layout umbrechen und das Logo verschieben.
const setupWindow = (x, y, w, h) =>
    jxa(
        `function run([x, y, w, h]) {
  const s = Application('Safari')
  s.activate()
  if (!s.windows.length) { s.Document().make(); delay(0.5) }
  s.windows[0].bounds = { x: Number(x), y: Number(y), width: Number(w), height: Number(h) }
}`,
        x,
        y,
        w,
        h
    )

// Bildschirme in globalen Koordinaten (Punkte, Ursprung oben links am Hauptbildschirm),
// so wie Fenster-Bounds und screencapture sie verwenden. NSScreen zählt y von unten.
async function screens() {
    const out = await jxa(`ObjC.import('AppKit')
function run() {
  const all = $.NSScreen.screens.js, mainH = all[0].frame.size.height
  return JSON.stringify(all.map((s) => {
    const f = s.frame
    return { name: s.localizedName.js, x: f.origin.x, y: mainH - f.origin.y - f.size.height, w: f.size.width, h: f.size.height }
  }))
}`)
    return JSON.parse(out)
}

const frontApp = () => jxa(`ObjC.import('AppKit'); function run() { return $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js }`)

const canCaptureScreen = async () =>
    (await jxa(`ObjC.import('CoreGraphics'); ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); function run() { return $.CGPreflightScreenCaptureAccess() }`)) ===
    'true'

// ---------------------------------------------------------------- Bühne: Hintergrund, Hell/Dunkel, andere Apps

// Randloses Farbfenster auf allen Bildschirmen, knapp unter normalen Fenstern. Es verdeckt
// Schreibtischbild, Icons und Widgets, Safari liegt darüber. So muss weder das Schreibtischbild
// geändert noch der Finder neu gestartet werden. Läuft als eigener osascript-Prozess.
const BACKDROP_JXA = `ObjC.import('Cocoa')
ObjC.bindFunction('CGWindowLevelForKey', ['int', ['int']])
function run([color]) {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const wins = $.NSScreen.screens.js.map((s) => {
    const w = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(s.frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false)
    w.backgroundColor = color === 'black' ? $.NSColor.blackColor : $.NSColor.whiteColor
    w.level = $.CGWindowLevelForKey(4) - 1 // knapp unter normalen Fenstern, über Desktop-Icons und Widgets
    w.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary | $.NSWindowCollectionBehaviorIgnoresCycle
    w.ignoresMouseEvents = true
    w.orderFrontRegardless
    return w
  })
  app.run
}`
let backdrop = null
process.on('exit', () => backdrop?.kill())

async function setBackdrop(color) {
    const old = backdrop
    const p = spawn('osascript', ['-l', 'JavaScript', '-e', BACKDROP_JXA, '--', color], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    backdrop = p
    await sleep(500) // neues Fenster steht, bevor das alte verschwindet
    old?.kill()
    if (p.exitCode !== null) throw new Error(`Hintergrundfenster ließ sich nicht öffnen: ${err.trim()}`)
}

// Setzt Dark Mode, Dock und Menüleiste (automatisch ausblenden) über System Events
// und liefert die vorherigen Werte, damit sie am Ende zurückgesetzt werden können.
async function systemUi(settings) {
    const out = await jxa(
        `function run([json]) {
  const se = Application('System Events'), a = se.appearancePreferences, d = se.dockPreferences
  const before = { dark: a.darkMode(), dock: d.autohide(), menu: d.autohideMenuBar() }
  const s = JSON.parse(json)
  if ('dark' in s && s.dark !== before.dark) a.darkMode = s.dark
  if ('dock' in s && s.dock !== before.dock) d.autohide = s.dock
  if ('menu' in s && s.menu !== before.menu) d.autohideMenuBar = s.menu
  return JSON.stringify(before)
}`,
        JSON.stringify(settings)
    )
    return JSON.parse(out)
}

// Holt Safari nach vorn und blendet alle anderen sichtbaren Apps aus (auch das Terminal).
// Erst Safari aktivieren: die aktive App lässt sich nicht ausblenden.
const hiddenApps = new Set()
async function hideOthers() {
    const out = await jxa(`function run() {
  Application('Safari').activate()
  delay(0.3)
  const se = Application('System Events')
  const names = se.processes.whose({ visible: true, backgroundOnly: false }).name().filter((n) => n !== 'Safari' && n !== 'osascript')
  for (const n of names) se.processes.byName(n).visible = false
  return JSON.stringify(names)
}`)
    for (const n of JSON.parse(out)) hiddenApps.add(n)
}

const showApps = (names) =>
    jxa(
        `function run([json]) {
  const se = Application('System Events')
  for (const n of JSON.parse(json)) { try { se.processes.byName(n).visible = true } catch (e) {} }
}`,
        JSON.stringify(names)
    )

// hell: Light Mode + weißer Hintergrund, dunkel: Dark Mode + schwarzer Hintergrund.
let look = null
async function setLook(mode) {
    if (look === mode) return
    await Promise.all([setBackdrop(mode === 'dunkel' ? 'black' : 'white'), systemUi({ dark: mode === 'dunkel' })])
    look = mode
}

let original = null // Dark Mode, Dock, Menüleiste vor dem Lauf
let terminal = null // App, aus der das Script gestartet wurde

// Alles zurück wie vor dem Lauf. Darf mehrfach laufen und wirft nicht.
async function cleanup() {
    backdrop?.kill()
    backdrop = null
    if (original) await systemUi(original).catch((e) => console.error(`Einstellungen nicht zurückgesetzt: ${e.message}`))
    original = null
    if (hiddenApps.size) await showApps([...hiddenApps]).catch(() => {})
    hiddenApps.clear()
    if (terminal) await activate(terminal).catch(() => {})
}

// ---------------------------------------------------------------- Seiten-JS
// Die folgenden Funktionen laufen in Safari (per toString übertragen), nicht in Node.
// Sie dürfen nichts aus diesem Modul verwenden und liefern JSON-Strings.

function pageState() {
    if (window.__wsOld) return JSON.stringify('old')
    // Nur sichtbare Bilder oben im Viewport. Versteckte Lazy-Bilder (Karussells) laden nie fertig.
    const imgs = [...document.images].filter((i) => {
        const r = i.getBoundingClientRect()
        return r.width > 0 && r.top < 400 && r.bottom > 0 && r.left < innerWidth && r.right > 0
    })
    if (document.readyState !== 'complete' || document.fonts.status !== 'loaded') return JSON.stringify('loading')
    return JSON.stringify(imgs.every((i) => i.complete) ? 'ready' : 'images')
}

function dismissCookies() {
    const SELECTORS = [
        '#onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept',
        '#didomi-notice-agree-button',
        '[data-testid="uc-accept-all-button"]',
        '.fc-cta-consent',
        '.cmpboxbtnyes',
        '#truste-consent-button',
        '.cky-btn-accept',
        '[data-cookiefirst-action="accept"]',
    ]
    const TEXT =
        /^(alle[mns]?\s+)?(cookies\s+)?(akzeptieren|annehmen|zustimmen|zulassen|erlauben|einverstanden|ich stimme zu|accept|agree|allow|i agree|ok\b|okay|got it|verstanden)/i
    const CONSENT = /cookie|consent|gdpr|privacy|cmp|dsgvo|datenschutz|tracking/i
    const roots = []
    const collect = (root) => {
        roots.push(root)
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) collect(el.shadowRoot)
            if (el.tagName === 'IFRAME') {
                try {
                    if (el.contentDocument) collect(el.contentDocument)
                } catch {} // cross-origin: nicht erreichbar
            }
        }
    }
    collect(document)
    const visible = (el) => el.getClientRects().length > 0 && (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true)
    // Nur Buttons in etwas, das nach Consent aussieht, damit kein normaler Link geklickt wird.
    const inConsent = (el, root) => {
        if (root !== document) return true
        for (let e = el; e; e = e.parentElement) {
            if (e.matches('[role=dialog], [aria-modal=true]')) return true
            if (CONSENT.test(`${e.id} ${typeof e.className === 'string' ? e.className : ''} ${e.getAttribute('aria-label') || ''}`)) return true
        }
        return false
    }
    for (const root of roots)
        for (const sel of SELECTORS) {
            const el = root.querySelector(sel)
            if (el && visible(el)) {
                el.click()
                return JSON.stringify(sel)
            }
        }
    for (const root of roots)
        for (const el of root.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]')) {
            const t = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ')
            if (t.length < 40 && TEXT.test(t) && visible(el) && inConsent(el, root)) {
                el.click()
                return JSON.stringify(t)
            }
        }
    return JSON.stringify(null)
}

// Sucht das Logo (meist oben links im Header) und liefert seine Box im Viewport.
// reuse: das beim letzten Mal gefundene Element weiterverwenden.
function findLogo(reuse) {
    scrollTo(0, 0)
    const visible = (e) => e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true
    let el = reuse ? document.querySelector('[data-ws-logo]') : null
    if (!el) {
        for (const e of document.querySelectorAll('[data-ws-logo]')) e.removeAttribute('data-ws-logo')
        const site = (h) => h.replace(/^www\d?\./, '')
        const brand = site(location.hostname).split('.')[0].toLowerCase()
        const lang = (document.documentElement.lang || '').toLowerCase().split('-')[0]
        const LOGO = /logo|wordmark/i // nicht "brand": Tailwind-Klassen wie bg-brand stehen überall
        const attrs = (e) =>
            [
                e.id,
                typeof e.className === 'string' ? e.className : e.className?.baseVal,
                e.getAttribute('alt'),
                e.getAttribute('aria-label'),
                e.getAttribute('title'),
                e.getAttribute('src'),
                e.querySelector?.(':scope > title')?.textContent,
                e.querySelector?.(':scope > use')?.getAttribute('href'),
            ].join(' ')
        // Link auf die Startseite: "/", ".../home(page)", oder Sprach-Root wie /de/ bzw. /de-de/ passend zu <html lang>
        const isHome = (a) => {
            try {
                const u = new URL(a.href, location.href)
                const p = u.pathname.toLowerCase().replace(/^\/+|\/+$/g, '')
                return (
                    site(u.hostname) === site(location.hostname) &&
                    (p === '' ||
                        /(^|\/)(home|homepage|start|startseite|index)(\.\w+)?$/.test(p) ||
                        (!!lang && /^[a-z]{2}([-_/][a-z]{2})?$/.test(p) && p.split(/[-_/]/).includes(lang)))
                )
            } catch {
                return false
            }
        }
        const best = new Map() // grafisches Element -> Score
        for (const c of document.querySelectorAll('img, svg, picture, [class*=logo i], [id*=logo i], [itemprop=logo], a[href]')) {
            if (c.tagName === 'A' && !isHome(c)) continue
            if (c.closest('svg') && c.tagName.toLowerCase() !== 'svg') continue // Teile eines SVG
            const g = c.matches('img, svg') ? c : [...c.querySelectorAll('img, svg')].find((e) => e.getBoundingClientRect().width > 0) || c
            const r = g.getBoundingClientRect()
            if (r.width < 8 || r.width > 600 || r.height < 8 || r.height > 250) continue // Apple-Logo ist nur 14 pt breit
            if (r.top < -1 || r.top > 400 || r.left < 0 || r.right > innerWidth || !visible(g)) continue
            const ctx = []
            for (let e = g, i = 0; e && i < 4; e = e.parentElement, i++) ctx.push(attrs(e))
            const text = ctx.join(' ')
            const home = g.closest('a[href]')
            let s = 0
            if (LOGO.test(text)) s += 5
            if (home && isHome(home)) s += 4
            const inArticle = !!g.closest('article') // Teaser haben eigene <header> mit Marken-Icons
            if (inArticle) s -= 4
            else if (g.closest('header, nav, [role=banner]')) s += 3
            if (brand.length > 2 && text.toLowerCase().includes(brand)) s += 3
            if (r.width * r.height < 400) s -= 3 // Icons wie 16×16, das Apple-Logo (14×44) bleibt darüber
            s -= r.top / 100 + r.left / 500
            if (!(best.get(g) >= s)) best.set(g, s)
        }
        const [winner] = [...best].sort((a, b) => b[1] - a[1])
        if (!winner || winner[1] < 3) return JSON.stringify(null)
        const g = winner[0]
        const cls = typeof g.className === 'string' ? g.className : g.className?.baseVal || ''
        let desc = `<${g.tagName.toLowerCase()}${g.id ? '#' + g.id : ''}${cls ? '.' + cls.trim().split(/\s+/).slice(0, 2).join('.') : ''}> Score ${winner[1].toFixed(1)}`
        // Bildmarke + Schriftzug im selben Startseiten-Link zählen zusammen als Logo.
        el = g
        const home = g.closest('a[href]')
        if (home && home !== g && isHome(home)) {
            const r = home.getBoundingClientRect()
            if (r.width <= 600 && r.height <= 250) {
                el = home
                desc += ' im Startseiten-Link'
            }
        }
        el.setAttribute('data-ws-logo', desc)
    }
    // Box = Vereinigung aller sichtbaren Bilder/SVGs im Logo-Element (oder das Element selbst).
    const parts = el.matches('img, svg')
        ? [el]
        : [...el.querySelectorAll('img, svg')].filter((e) => !e.parentElement.closest('svg') && e.getBoundingClientRect().width > 0 && visible(e))
    const rects = (parts.length ? parts : [el]).map((e) => e.getBoundingClientRect())
    const left = Math.min(...rects.map((r) => r.left))
    const top = Math.min(...rects.map((r) => r.top))
    return JSON.stringify({
        desc: el.getAttribute('data-ws-logo') + (parts.length > 1 ? `, ${parts.length} Teile` : ''),
        left,
        top,
        width: Math.max(...rects.map((r) => r.right)) - left,
        height: Math.max(...rects.map((r) => r.bottom)) - top,
        // Abstand Fensterrand -> Seiteninhalt (Titel-, Tab-, Favoritenleiste, ggf. Seitenleiste)
        chromeX: outerWidth - innerWidth,
        chromeY: outerHeight - innerHeight,
    })
}

// ---------------------------------------------------------------- Platzierung

// Box des Logos in globalen Bildschirmkoordinaten (Punkte).
function logoBox(m) {
    return { x: m.bounds.x + m.chromeX + m.left, y: m.bounds.y + m.chromeY + m.top, w: m.width, h: m.height }
}

// Wie weit das Fenster wandern muss, damit Logo-Mitte + offset auf target liegt.
function windowMove(m, offset, target) {
    const b = logoBox(m)
    return { x: target.x - (b.x + b.w / 2 + offset.x), y: target.y - (b.y + b.h / 2 + offset.y) }
}

assert.deepEqual(windowMove({ bounds: { x: 100, y: 50 }, chromeX: 0, chromeY: 80, left: 40, top: 20, width: 120, height: 40 }, { x: 2, y: -1 }, { x: 1280, y: 720 }), {
    x: 1280 - (100 + 40 + 60 + 2),
    y: 720 - (50 + 80 + 20 + 20 - 1),
})

// Mitte des Inhalts nach sharp().trim(), umgerechnet in Bildschirmpunkte.
// trimOffsetLeft/Top sind negativ (Verschiebung des Ausschnitts), scale = Pixel pro Punkt.
function trimCenter(info, scale, rx, ry) {
    return {
        x: rx + (-info.trimOffsetLeft + info.width / 2) / scale,
        y: ry + (-info.trimOffsetTop + info.height / 2) / scale,
        w: info.width / scale,
        h: info.height / scale,
    }
}

assert.deepEqual(trimCenter({ trimOffsetLeft: -30, trimOffsetTop: -10, width: 20, height: 20 }, 2, 100, 50), { x: 120, y: 60, w: 10, h: 10 })

// Fotografiert den Bildschirmausschnitt um box und liefert die Mitte dessen, was sich
// vom Hintergrund abhebt. So zählen transparente Ränder und Padding nicht mit.
// null, wenn nichts Brauchbares gefunden wurde.
const SHOT_FILE = path.join(os.tmpdir(), `web-shooter-${process.pid}.png`)
async function paintedCenter(box) {
    const M = 4 // Rand, damit die Ecke oben links sicher Hintergrund ist (sharp nimmt sie als Hintergrundfarbe)
    const rx = Math.floor(box.x - M)
    const ry = Math.floor(box.y - M)
    const rw = Math.ceil(box.x + box.w + M) - rx
    const rh = Math.ceil(box.y + box.h + M) - ry
    await run('screencapture', ['-x', '-t', 'png', `-R${rx},${ry},${rw},${rh}`, SHOT_FILE])
    const buf = await fs.readFile(SHOT_FILE)
    await fs.rm(SHOT_FILE, { force: true })
    const { width: iw, height: ih } = await sharp(buf).metadata()
    const { info } = await sharp(buf).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true })
    if (info.width === iw && info.height === ih) return null // nichts abgeschnitten, Hintergrund nicht einfarbig
    const c = trimCenter(info, iw / rw, rx, ry)
    const tooSmall = c.w * c.h < 0.1 * box.w * box.h
    const outside = Math.abs(c.x - (box.x + box.w / 2)) > box.w / 2 || Math.abs(c.y - (box.y + box.h / 2)) > box.h / 2
    return tooSmall || outside ? null : c
}

let refine = true // wird false ohne Berechtigung "Bildschirmaufnahme"

// Logo finden und das Fenster verschieben, bis die Logo-Mitte auf target liegt.
// Erst nach DOM-Box, dann einmal pixelgenau nachkorrigiert. Nach jedem Schritt wird neu gemessen,
// weil macOS Fenster unter der Menüleiste festhält oder zwischen Bildschirmen umsetzt.
async function placeLogo(target) {
    let offset = { x: 0, y: 0 }
    let refined = !refine
    for (let i = 0; i < PLACE_ATTEMPTS; i++) {
        const { r, bounds } = await page(findLogo, i > 0)
        if (!r) throw new Error('Kein Logo gefunden')
        const m = { ...r, bounds }
        const d = windowMove(m, offset, target)
        if (Math.abs(d.x) > TOLERANCE_PT || Math.abs(d.y) > TOLERANCE_PT) {
            await moveWindow(Math.round(d.x), Math.round(d.y))
            await sleep(150)
            continue
        }
        if (!refined) {
            refined = true
            const box = logoBox(m)
            const c = await paintedCenter(box)
            if (c) offset = { x: c.x - (box.x + box.w / 2), y: c.y - (box.y + box.h / 2) }
            else console.log('  Pixelgenaue Mitte nicht ermittelbar, nutze Mitte der Element-Box.')
            continue
        }
        if (m.chromeX > 1) console.log(`  Achtung: Inhalt ${m.chromeX} pt vom linken Fensterrand. Seitenzoom 100 % und Seitenleiste zu?`)
        // Kontrolle: Was steht jetzt wirklich in der Bildschirmmitte?
        const check = refine ? await paintedCenter({ x: target.x - m.width / 2, y: target.y - m.height / 2, w: m.width, h: m.height }) : null
        const dev = check ? `Abweichung ${(check.x - target.x).toFixed(1)}/${(check.y - target.y).toFixed(1)} pt` : 'ohne Pixelkontrolle'
        console.log(
            `  Logo: ${m.desc}, ${Math.round(m.width)}×${Math.round(m.height)} pt, Korrektur ${offset.x.toFixed(1)}/${offset.y.toFixed(1)} pt, Fensterrahmen ${m.chromeX}/${m.chromeY} pt, ${dev}`
        )
        if (check && Math.hypot(check.x - target.x, check.y - target.y) > 2) console.log('  Achtung: Logo steht sichtbar neben der Mitte!')
        return m
    }
    throw new Error('Fenster lässt sich nicht so platzieren, dass das Logo mittig ist (Logo zu weit oben?)')
}

// ---------------------------------------------------------------- Seite laden

async function load(url) {
    // Markierung an der alten Seite, damit sie nicht für die neue gehalten wird.
    await page(() => ((window.__wsOld = true), '1')).catch(() => {})
    await setUrl(url)
    await waitReady()
    await sleep(SETTLE_MS)
    // Banner kommen oft verzögert, daher zweimal versuchen. Manche laden nach dem Klick die Seite neu.
    for (let k = 0; k < 2; k++) {
        const { r } = await page(dismissCookies)
        if (!r) {
            await sleep(700)
            continue
        }
        console.log(`  Cookie-Banner: "${r}" geklickt`)
        await sleep(1000)
        await waitReady()
    }
}

async function waitReady() {
    const until = Date.now() + LOAD_TIMEOUT_MS
    let imagesSince = null
    for (;;) {
        // Während der Navigation schlägt doJavaScript gelegentlich fehl, dann einfach weiter pollen.
        const state = await page(pageState).then(
            (p) => p.r,
            () => null
        )
        if (state === 'ready') break
        // Manche Lazy-Bilder laden in Safari nie (z. B. auf heise.de), darauf nur kurz warten.
        imagesSince = state === 'images' ? (imagesSince ?? Date.now()) : null
        if (imagesSince && Date.now() - imagesSince > IMAGE_WAIT_MS) break
        if (Date.now() > until) {
            if (state !== 'loading' && state !== 'images') throw new Error('Seite lädt nicht (Timeout)')
            console.log('  Seite lädt noch, mache trotzdem weiter.')
            break
        }
        await sleep(300)
    }
}

// ---------------------------------------------------------------- Kamera

async function releaseUsbOnMac() {
    // macOS greift sich per PTPCamera (neuere Versionen: ptpcamerad) die Kamera
    // und blockiert dann gphoto2. ptpcamerad startet neu, reagiert nur auf -9.
    if (process.platform === 'darwin') await run('killall', ['-9', 'PTPCamera', 'ptpcamerad']).catch(() => {})
}

async function checkCamera() {
    await releaseUsbOnMac()
    const { out } = await run('gphoto2', ['--auto-detect'])
    const lines = out.split('\n')
    const sep = lines.findIndex((l) => /^-{5,}/.test(l))
    const cams = lines
        .slice(sep + 1)
        .map((l) => l.trim())
        .filter(Boolean)
    if (!cams.length) throw new Error('gphoto2 findet keine Kamera. USB-Kabel, Kamera an?')
    console.log(`Kamera: ${cams[0]}`)
}

// Nächste freie fortlaufende Nummer (0001, 0002, …): höchste vierstellige
// Nummer im Ausgabeordner + 1, damit auch nach Neustart nichts überschrieben wird.
async function nextNumber() {
    let max = 0
    for (const f of await fs.readdir(OUT_DIR)) {
        const m = /^(\d{4,})\./.exec(f)
        if (m) max = Math.max(max, Number(m[1]))
    }
    return String(max + 1).padStart(4, '0')
}

async function capture() {
    // Erst in einen Zwischenordner laden, damit gphoto2 nie eine vorhandene
    // Datei im Ausgabeordner überschreibt. %f = Dateiname auf der Kamera ohne
    // Endung, %C = Endung (z. B. CR3).
    const incoming = path.join(OUT_DIR, '.incoming')
    await fs.mkdir(incoming, { recursive: true })
    const { out } = await run('gphoto2', ['--capture-image-and-download', '--force-overwrite', '--filename', path.join(incoming, '%f.%C')])
    const saved = [...out.matchAll(/Saving file as (.+)$/gm)].map((m) => path.resolve(m[1].trim()))
    if (!saved.length) throw new Error(`gphoto2 hat keine Datei gespeichert:\n${out.trim()}`)

    // Alle Dateien einer Aufnahme (z. B. CR3 + JPG) bekommen dieselbe Nummer.
    const nr = await nextNumber()
    const files = []
    for (const src of saved) {
        const dest = path.join(OUT_DIR, nr + path.extname(src))
        await fs.rename(src, dest)
        files.push(dest)
    }
    return files
}

async function captureWithRetry() {
    for (let attempt = 1; ; attempt++) {
        try {
            return await capture()
        } catch (e) {
            if (attempt >= CAPTURE_ATTEMPTS) throw e
            console.log(`  Auslösen fehlgeschlagen (Versuch ${attempt}/${CAPTURE_ATTEMPTS}): ${e.message}`)
            await releaseUsbOnMac()
            await sleep(1500)
        }
    }
}

// ---------------------------------------------------------------- Metadaten

function xmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const description = (site) => `${site.domain} – ${site.name}`

// Titel = Name, Beschreibung = Domain und Name, dc:subject = Keywords (tagger.mjs nutzt alles als Hinweis),
// dc:source = URL (bleibt erhalten, tagger.mjs fasst sie nicht an).
function buildXmp(site) {
    const subject = site.keywords.length
        ? `
   <dc:subject>
    <rdf:Bag>${site.keywords.map((k) => `<rdf:li>${xmlEscape(k)}</rdf:li>`).join('')}</rdf:Bag>
   </dc:subject>`
        : ''
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title>
    <rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(site.name)}</rdf:li></rdf:Alt>
   </dc:title>
   <dc:description>
    <rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(description(site))}</rdf:li></rdf:Alt>
   </dc:description>${subject}
   <dc:source>${xmlEscape(site.url)}</dc:source>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`
}

async function writeMeta(file, site) {
    if (args.embed) {
        const tags = [`-XMP-dc:Title=${site.name}`, `-XMP-dc:Description=${description(site)}`, `-XMP-dc:Source=${site.url}`, ...site.keywords.map((k) => `-XMP-dc:Subject=${k}`)]
        await run('exiftool', ['-overwrite_original', '-m', ...tags, file])
        return file
    }
    const sidecar = file.replace(/\.[^.]+$/, '') + '.xmp'
    await fs.writeFile(sidecar, buildXmp(site), 'utf8')
    return sidecar
}

// ---------------------------------------------------------------- Ablauf

let aborting = false

async function abort() {
    if (aborting) return
    aborting = true
    console.log('\nAbgebrochen. Zum Fortsetzen neu starten, Einträge mit Status werden übersprungen.')
    await cleanup()
    process.exit(130)
}
process.on('SIGINT', abort)

async function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', abort) // readline fängt Ctrl-C sonst selbst ab
    try {
        return (await rl.question(question)).trim().toLowerCase()
    } finally {
        rl.close()
    }
}

async function main() {
    const rows = parseSites(await fs.readFile(CSV_FILE, 'utf8'))
    const sites = rows.filter((s) => !s.status)
    console.log(`${CSV_FILE}: ${sites.length} offen, ${rows.length - sites.length} mit Status übersprungen`)
    const dups = duplicates(rows)
    if (dups.length) {
        console.log(`\nDoppelte Domains (${dups.length}):`)
        for (const g of dups) {
            console.log(`  ${g[0].domain}`)
            for (const r of g) console.log(`    Zeile ${r.line + 1}: ${r.name}${r.status ? ` [${r.status}]` : ''}`)
        }
        console.log()
    }
    if (!sites.length) return console.log('Keine offenen Einträge.')
    if (dups.length && (await ask('Enter = trotzdem starten, q = abbrechen: ')) === 'q') return
    await fs.mkdir(OUT_DIR, { recursive: true })

    if (!DRY) {
        await checkCamera()
        if (args.embed) await run('exiftool', ['-ver'])
    } else {
        console.log('Dry-Run: Kamera wird nicht ausgelöst.')
    }

    const all = await screens()
    all.forEach((s, i) => console.log(`Bildschirm ${i + 1}: ${s.name}, ${s.w}×${s.h} pt bei ${s.x}/${s.y}`))
    const disp = all[DISPLAY - 1]
    if (!disp) throw new Error(`Bildschirm ${args.display} gibt es nicht`)
    const target = { x: disp.x + disp.w / 2, y: disp.y + disp.h / 2 }
    console.log(`Ziel: Mitte von Bildschirm ${DISPLAY} (${target.x}/${target.y})`)

    refine = await canCaptureScreen()
    if (!refine) console.log('Achtung: Keine Berechtigung "Bildschirmaufnahme". Nutze die Mitte der Element-Box statt pixelgenau.')

    terminal = await frontApp() // dorthin zurück, damit Enter ohne Klick geht
    await setupWindow(disp.x + 40, disp.y + 60, WIN_W, WIN_H)
    try {
        await page(() => '1')
    } catch (e) {
        throw new Error(
            `Safari lässt kein JavaScript zu. In Safari: Einstellungen > Erweitert > "Funktionen für Webentwickler" an, dann Entwickler > Entwickler-Einstellungen > "JavaScript von Apple Events erlauben".\n${e.message}`
        )
    }
    original = await systemUi({ dock: true, menu: true })

    const log = path.join(OUT_DIR, 'web-shots.csv')
    if (!fssync.existsSync(log)) await fs.writeFile(log, 'zeit;nr;url;modus;datei;status\n')
    const logLine = (i, mode, file, status) => fs.appendFile(log, `${new Date().toISOString()};${i + 1};${sites[i].url};${mode};${file};${status}\n`)

    async function shoot(i, mode) {
        for (let s = 1; s <= SHOTS; s++) {
            if (DRY) {
                console.log(`  (dry-run) Aufnahme ${mode} ${s}/${SHOTS}`)
                await sleep(500)
                continue
            }
            const files = await captureWithRetry()
            for (const f of files) {
                const meta = await writeMeta(f, sites[i])
                await logLine(i, mode, path.basename(f), 'ok')
                console.log(`  ${mode}: ${path.basename(f)}  ->  ${path.basename(meta)}  "${sites[i].name}"`)
            }
        }
    }

    playSound('Glass') // nicht awaiten, Durchlauf startet sofort
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i]
        console.log(`\n[${i + 1}/${sites.length}] ${site.domain} – ${site.name}`)

        const [first, ...rest] = MODES
        try {
            await setLook(first)
            await load(site.url)
            await hideOthers()
            await placeLogo(target)
            if (PAUSE) {
                await activate(terminal)
                if ((await ask('  Enter = auslösen, s = überspringen: ')) === 's') {
                    await logLine(i, first, '', 'übersprungen')
                    continue
                }
                // Neu messen: Banner können weg sein, das Layout kann sich verschoben haben.
                await hideOthers()
                await sleep(300)
                await placeLogo(target)
            }
        } catch (e) {
            console.log(`  Übersprungen: ${e.message}`)
            await logLine(i, first, '', `fehler: ${e.message.split('\n')[0]}`)
            continue
        }
        await shoot(i, first)

        // Umschalten: Seiten mit prefers-color-scheme stellen live um, das Logo kann ein anderes
        // Element sein (z. B. helle/dunkle Variante). Daher neu suchen und neu platzieren.
        for (const mode of rest) {
            try {
                console.log(`  Umschalten auf ${mode} …`)
                await setLook(mode)
                await sleep(1000)
                await waitReady()
                await placeLogo(target)
            } catch (e) {
                console.log(`  ${mode} übersprungen: ${e.message}`)
                await logLine(i, mode, '', `fehler: ${e.message.split('\n')[0]}`)
                continue
            }
            await shoot(i, mode)
        }
        // Erst nach allen Modi, damit ein Abbruch mittendrin den Eintrag offen lässt.
        if (!DRY) await saveStatus(site.domain).catch((e) => console.log(`  Achtung: Status nicht gespeichert: ${e.message}`))
    }

    await cleanup()
    console.log('\nFertig.')
    await playSound('Hero')
    process.exit(0)
}

main().catch(async (e) => {
    if (aborting) return // Ctrl-C: abort() räumt auf und beendet
    console.error(`\nFehler: ${e.message}`)
    await cleanup()
    process.exit(1)
})

