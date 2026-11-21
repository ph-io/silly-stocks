#!/usr/bin/env node
// stockshooter.mjs
//
// Zeigt Logos nacheinander im Vollbild auf dem iPhone an, löst die Kamera per
// gphoto2 aus, lädt die RAW-Datei unter dem Kamera-Dateinamen (z. B. IMG_1234.CR3)
// auf den Mac und schreibt den Logonamen als Titel und Beschreibung in eine XMP-Datei.
//
// Anzeige auf dem iPhone: am besten über die App "Shooter" (ios/ShooterApp.swift),
// die ohne Statusleiste und Home-Indikator läuft. Safari geht zum Testen auch.
//
// Voraussetzungen: Node.js 18.3+, gphoto2 (brew install gphoto2),
// optional exiftool (brew install exiftool) für --embed.
//
// Aufruf:
//   node stockshooter.mjs
//
// Optionen:
//   --logos <dir>     Ordner mit den vorbereiteten Bildern (png/jpg/webp)   [./logos/output/png]
//   --out <dir>       Zielordner für die Kameradateien                      [./out]
//   --port <n>        Port des Webservers                                  [8080]
//   --start <n>       Mit Bild Nr. n beginnen (1-basiert, zum Fortsetzen)  [1]
//   --shots <n>       Aufnahmen pro Logo                                   [1]
//   --settle <ms>     Wartezeit nach Bildanzeige vor dem Auslösen          [800]
//   --fit <contain|cover>  contain: ganzes Bild sichtbar, Rest in der Farbe
//                     des Bildrands (oben links) gefüllt; cover: Bildschirm
//                     füllen, ggf. seitlich beschneiden                      [contain]
//   --align <center|top>   Bei contain: Bild mittig oder oben ausrichten   [center]
//   --embed           XMP per exiftool in die CR3 schreiben statt Sidecar-Datei
//   --dry-run         Ohne Kamera: nur Anzeige auf dem iPhone durchtesten
//   --no-pause        Vor dem Start nicht auf Enter warten

import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    logos: { type: "string", default: "./logos/output/png/centered" },
    out: { type: "string", default: "./out" },
    port: { type: "string", default: "8080" },
    start: { type: "string", default: "1" },
    shots: { type: "string", default: "1" },
    settle: { type: "string", default: "800" },
    fit: { type: "string", default: "contain" },
    align: { type: "string", default: "center" },
    embed: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-pause": { type: "boolean", default: false },
  },
});

const LOGO_DIR = path.resolve(args.logos);
const OUT_DIR = path.resolve(args.out);
const PORT = Number(args.port);
const SHOTS = Math.max(1, Number(args.shots));
const SETTLE_MS = Math.max(0, Number(args.settle));
const FIT = args.fit === "cover" ? "cover" : "contain";
const ALIGN = args.align === "top" ? "top" : "center";
const DRY = args["dry-run"];
const ACK_TIMEOUT_MS = 10_000;
const CAPTURE_ATTEMPTS = 3;

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// Text, der in Titel und Beschreibung landet: Dateiname des Logos ohne Endung.
function captionFor(logoFile) {
  return path.basename(logoFile, path.extname(logoFile));
}

// ---------------------------------------------------------------- Hilfsfunktionen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(
        e.code === "ENOENT"
          ? new Error(`${cmd} nicht gefunden (installiert?)`)
          : e,
      ),
    );
    p.on("close", (code) =>
      code === 0
        ? resolve({ out, err })
        : reject(
            new Error(
              `${cmd} beendet mit Code ${code}: ${(err || out).trim()}`,
            ),
          ),
    );
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

// ---------------------------------------------------------------- iPhone-Seite

const PAGE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Shooter">
<link rel="manifest" href="/manifest.json">
<title>Shooter</title>
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; touch-action: none; }
  #img { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  #img:not([src]) { display: none; }
  #status { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
            color: #777; font: 15px -apple-system, system-ui, sans-serif; text-align: center; }
</style>
</head>
<body>
<img id="img" alt="">
<div id="status">Verbinde …</div>
<script>
  const img = document.getElementById('img');
  const status = document.getElementById('status');
  let latest = -1;

  function setStatus(t) { status.textContent = t; status.style.display = t ? '' : 'none'; }

  // Wake Lock funktioniert nur in sicheren Kontexten (https). Im LAN über http
  // greift es meist nicht, daher am iPhone "Automatische Sperre: Nie" setzen.
  async function wake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  document.addEventListener('touchend', wake);
  wake();

  const es = new EventSource('/events');
  es.onopen = () => setStatus(img.getAttribute('src') ? '' : 'Verbunden, warte auf Bild …');
  es.onerror = () => { if (!img.getAttribute('src')) setStatus('Verbindung getrennt …'); };
  es.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    latest = msg.id;
    const pre = new Image();
    pre.src = msg.url;
    try { await pre.decode(); } catch { setStatus('Bild konnte nicht geladen werden'); return; }
    if (msg.id !== latest) return;
    // Freie Fläche in der Farbe des Bildrands (Pixel oben links) füllen.
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d');
      ctx.drawImage(pre, 0, 0, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      document.documentElement.style.background = document.body.style.background = 'rgb(' + r + ',' + g + ',' + b + ')';
    } catch {}
    img.style.objectFit = msg.fit;
    img.style.objectPosition = msg.align === 'top' ? 'center top' : 'center center';
    img.src = pre.src;
    try { await img.decode(); } catch {}
    setStatus('');
    // Zwei Frames abwarten, damit das Bild sicher auf dem Display ist.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (msg.id !== latest) return;
      fetch('/ack?id=' + msg.id, { method: 'POST' }).catch(() => {});
    }));
  };
</script>
</body>
</html>`;

const MANIFEST = JSON.stringify({
  name: "Stock Shooter",
  short_name: "Shooter",
  display: "standalone",
  background_color: "#000000",
  theme_color: "#000000",
  start_url: "/",
});

// ---------------------------------------------------------------- Server

const clients = new Set();
let current = null; // { id, url, fit }
let pendingAck = null; // { id, resolve }
let msgId = 0;
let logoSet = new Set();

function sendTo(res, msg) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(PAGE);
  }

  if (url.pathname === "/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    return res.end(MANIFEST);
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    clients.add(res);
    if (current) sendTo(res, current);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
      console.log(`  iPhone getrennt (${clients.size} verbunden)`);
    });
    console.log(`  iPhone verbunden (${clients.size} verbunden)`);
    return;
  }

  if (url.pathname === "/ack" && req.method === "POST") {
    const id = Number(url.searchParams.get("id"));
    if (pendingAck && pendingAck.id === id) pendingAck.resolve();
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname.startsWith("/logo/")) {
    const name = decodeURIComponent(url.pathname.slice("/logo/".length));
    if (!logoSet.has(name)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(name).toLowerCase()],
      "Cache-Control": "no-store",
    });
    return fssync.createReadStream(path.join(LOGO_DIR, name)).pipe(res);
  }

  res.writeHead(404);
  res.end();
});

async function waitForClient() {
  while (clients.size === 0) await sleep(300);
}

// Zeigt ein Logo an und wartet, bis das iPhone die Darstellung bestätigt.
// Bei Timeout (iPhone gesperrt, WLAN weg) wird erneut gesendet, bis es klappt.
async function showAndWait(logoFile) {
  for (;;) {
    await waitForClient();
    const id = ++msgId;
    current = {
      id,
      url: `/logo/${encodeURIComponent(logoFile)}?v=${id}`,
      fit: FIT,
      align: ALIGN,
    };
    const acked = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ACK_TIMEOUT_MS);
      pendingAck = {
        id,
        resolve: () => {
          clearTimeout(t);
          resolve(true);
        },
      };
    });
    for (const c of clients) sendTo(c, current);
    if (await acked) {
      pendingAck = null;
      return;
    }
    pendingAck = null;
    console.log(
      "  Keine Bestätigung vom iPhone, sende erneut … (iPhone entsperrt? Seite offen?)",
    );
  }
}

// ---------------------------------------------------------------- Kamera

async function releaseUsbOnMac() {
  // macOS greift sich die Kamera und blockiert dann gphoto2:
  // bis 10.14 per PTPCamera, ab 10.15 per ptpcamerad (User-LaunchAgent, startet neu).
  if (process.platform === "darwin")
    await run("killall", ["PTPCamera", "ptpcamerad"]).catch(() => {});
}

async function checkCamera() {
  await releaseUsbOnMac();
  const { out } = await run("gphoto2", ["--auto-detect"]);
  const lines = out.split("\n");
  const sep = lines.findIndex((l) => /^-{5,}/.test(l));
  const cams = lines
    .slice(sep + 1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!cams.length)
    throw new Error("gphoto2 findet keine Kamera. USB-Kabel, Kamera an?");
  console.log(`Kamera: ${cams[0]}`);
}

// Zielpfad im Ausgabeordner mit dem Kamera-Dateinamen. Nur wenn es den Namen
// dort schon gibt (z. B. gleicher Zählerstand bei R5 und R5 II), wird "-2"
// angehängt, damit nichts überschrieben wird.
async function targetFor(cameraName) {
  const ext = path.extname(cameraName);
  const stem = path.basename(cameraName, ext);
  const taken = new Set(
    (await fs.readdir(OUT_DIR)).map((f) =>
      f.replace(/\.[^.]+$/, "").toLowerCase(),
    ),
  );
  let candidate = stem;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${stem}-${n}`;
  return path.join(OUT_DIR, candidate + ext);
}

async function capture() {
  // Erst in einen Zwischenordner laden, damit gphoto2 nie eine vorhandene
  // Datei im Ausgabeordner überschreibt. %f = Dateiname auf der Kamera ohne
  // Endung, %C = Endung (z. B. CR3).
  const incoming = path.join(OUT_DIR, ".incoming");
  await fs.mkdir(incoming, { recursive: true });
  const { out } = await run("gphoto2", [
    "--capture-image-and-download",
    "--force-overwrite",
    "--filename",
    path.join(incoming, "%f.%C"),
  ]);
  const saved = [...out.matchAll(/Saving file as (.+)$/gm)].map((m) =>
    path.resolve(m[1].trim()),
  );
  if (!saved.length)
    throw new Error(`gphoto2 hat keine Datei gespeichert:\n${out.trim()}`);

  const files = [];
  for (const src of saved) {
    const dest = await targetFor(path.basename(src));
    if (path.basename(dest) !== path.basename(src))
      console.log(
        `  Achtung: ${path.basename(src)} gibt es schon, gespeichert als ${path.basename(dest)}`,
      );
    await fs.rename(src, dest);
    files.push(dest);
  }
  return files;
}

async function captureWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture();
    } catch (e) {
      if (attempt >= CAPTURE_ATTEMPTS) throw e;
      console.log(
        `  Auslösen fehlgeschlagen (Versuch ${attempt}/${CAPTURE_ATTEMPTS}): ${e.message}`,
      );
      await releaseUsbOnMac();
      await sleep(1500);
    }
  }
}

// ---------------------------------------------------------------- Metadaten

function xmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildXmp(text) {
  const t = xmlEscape(text);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title>
    <rdf:Alt><rdf:li xml:lang="x-default">${t}</rdf:li></rdf:Alt>
   </dc:title>
   <dc:description>
    <rdf:Alt><rdf:li xml:lang="x-default">${t}</rdf:li></rdf:Alt>
   </dc:description>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

async function writeMeta(file, text) {
  if (args.embed) {
    await run("exiftool", [
      "-overwrite_original",
      "-m",
      `-XMP-dc:Title=${text}`,
      `-XMP-dc:Description=${text}`,
      file,
    ]);
    return file;
  }
  const sidecar = file.replace(/\.[^.]+$/, "") + ".xmp";
  await fs.writeFile(sidecar, buildXmp(text), "utf8");
  return sidecar;
}

// ---------------------------------------------------------------- Ablauf

let currentIndex = null;

process.on("SIGINT", () => {
  if (currentIndex !== null)
    console.log(`\nAbgebrochen. Fortsetzen mit: --start ${currentIndex + 1}`);
  process.exit(130);
});

async function main() {
  const logos = (await fs.readdir(LOGO_DIR))
    .filter((f) => !f.startsWith(".") && MIME[path.extname(f).toLowerCase()])
    .sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
  if (!logos.length) throw new Error(`Keine Bilder in ${LOGO_DIR}`);
  logoSet = new Set(logos);

  const startIdx = Math.min(Math.max(1, Number(args.start)), logos.length) - 1;
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (!DRY) {
    await checkCamera();
    if (args.embed) await run("exiftool", ["-ver"]);
  } else {
    console.log("Dry-Run: Kamera wird nicht ausgelöst.");
  }

  await new Promise((r) => server.listen(PORT, "0.0.0.0", r));
  console.log(
    `\n${logos.length} Bilder in ${LOGO_DIR}, Start bei Nr. ${startIdx + 1}`,
  );
  console.log("Adresse für die iPhone-App (gleiches WLAN):");
  // Der .local-Name bleibt gleich, auch wenn sich die IP des Macs ändert.
  const host = os.hostname();
  if (host.endsWith(".local")) console.log(`  http://${host}:${PORT}/`);
  for (const ip of lanAddresses()) console.log(`  http://${ip}:${PORT}/`);
  console.log("\nWarte auf iPhone …");
  await waitForClient();

  await showAndWait(logos[startIdx]);
  if (!args["no-pause"]) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question(
      "\nErstes Bild wird angezeigt. Ausrichten, Fokus und Belichtung einstellen, dann Enter … ",
    );
    rl.close();
  }

  const log = path.join(OUT_DIR, "shots.csv");
  if (!fssync.existsSync(log)) await fs.writeFile(log, "zeit;nr;logo;datei\n");

  for (let i = startIdx; i < logos.length; i++) {
    currentIndex = i;
    const logo = logos[i];
    const caption = captionFor(logo);
    console.log(`\n[${i + 1}/${logos.length}] ${logo}`);

    await showAndWait(logo);
    await sleep(SETTLE_MS);

    for (let s = 1; s <= SHOTS; s++) {
      if (DRY) {
        console.log(`  (dry-run) Aufnahme ${s}/${SHOTS}`);
        await sleep(500);
        continue;
      }
      const files = await captureWithRetry();
      for (const f of files) {
        const meta = await writeMeta(f, caption);
        await fs.appendFile(
          log,
          `${new Date().toISOString()};${i + 1};${logo};${path.basename(f)}\n`,
        );
        console.log(
          `  ${path.basename(f)}  ->  ${path.basename(meta)}  "${caption}"`,
        );
      }
    }
  }

  currentIndex = null;
  console.log("\nFertig.");
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nFehler: ${e.message}`);
  if (currentIndex !== null)
    console.error(`Fortsetzen mit: --start ${currentIndex + 1}`);
  process.exit(1);
});
