import { ESPLoader, Transport } from 'https://cdn.jsdelivr.net/npm/esptool-js@0.5.7/bundle.js';
import { createLittleFS } from './wasm/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

let loader, transport, partition, image;

/** Severity levels for the log */
const LOG_LEVELS = { info: '  ', warn: '⚠ ', error: '✖ ', ok: '✔ ', debug: '… ' };

/**
 * Append a timestamped line to the log panel.
 * @param {string} msg
 * @param {'info'|'warn'|'error'|'ok'|'debug'} [level='info']
 */
function log(msg, level = 'info') {
  const prefix = LOG_LEVELS[level] ?? '  ';
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] ${prefix} ${msg}`;
  $('log').textContent += line + '\n';
  $('log').scrollTop = 1e9;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line);
}

function hex(n) { return '0x' + n.toString(16).toUpperCase().padStart(8, '0'); }

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1048576).toFixed(2)} MiB`;
}

function setProgress(pct, label = '') {
  $('progress').value = pct / 100;   // mdui-linear-progress uses 0-1
  $('progressLabel').textContent = label;
}

// ── Partition parsing ─────────────────────────────────────────────────────────

function parsePartitionTable(data) {
  const out = [];
  for (let p = 0; p + 32 <= data.length; p += 32) {
    const dv = new DataView(data.buffer, data.byteOffset + p, 32);
    if (dv.getUint16(0, true) !== 0x50aa) continue;
    const type    = data[p + 2];
    const subtype = data[p + 3];
    const offset  = dv.getUint32(4,  true);
    const size    = dv.getUint32(8,  true);
    let label = '';
    for (let i = 12; i < 28 && data[p + i]; i++) label += String.fromCharCode(data[p + i]);
    out.push({ type, subtype, offset, size, label });
  }
  return out;
}

async function readPartitions() {
  log('Reading partition table from 0x8000 (4 KiB)…', 'debug');
  const table = await loader.readFlash(0x8000, 0x1000);
  log(`Raw partition table received: ${fmtBytes(table.length)}`, 'debug');

  const parts = parsePartitionTable(table);
  log(`Parsed ${parts.length} partition entry(s)`, 'debug');

  parts.forEach(p => {
    log(`  Partition "${p.label}": type=${hex(p.type)} subtype=${hex(p.subtype)} offset=${hex(p.offset)} size=${fmtBytes(p.size)}`, 'debug');
  });

  let p = parts.find(x => /littlefs/i.test(x.label));
  if (!p) p = parts.find(x => x.type === 1 && (x.subtype === 0x82 || x.subtype === 0x83));
  if (!p) throw new Error(
    'LittleFS partition not found. Rename/mark the data partition or edit selection logic.'
  );

  partition = p;
  log(`Selected LittleFS partition: "${p.label}"  offset=${hex(p.offset)}  size=${fmtBytes(p.size)}`, 'ok');

  $('partition').textContent = JSON.stringify({
    label:   p.label,
    offset:  hex(p.offset),
    size:    p.size,
    sizeMiB: (p.size / 1048576).toFixed(2),
    subtype: hex(p.subtype),
  }, null, 2);

  $('build').disabled = false;
}

// ── Connect ───────────────────────────────────────────────────────────────────

$('connect').addEventListener('click', async () => {
  try {
    if (!('serial' in navigator)) throw new Error('Web Serial API requires Chrome or Edge.');

    log('Requesting serial port…', 'info');
    const port = await navigator.serial.requestPort();
    log('Port selected, initialising transport…', 'debug');

    transport = new Transport(port);
    loader = new ESPLoader({
      transport,
      baudrate: 921600,
      terminal: {
        clean() {},
        writeLine: m => log(`[esptool] ${m}`, 'debug'),
        write:     m => log(`[esptool] ${String(m)}`, 'debug'),
      },
    });

    log('Running esptool main (slip detection + chip detection)…', 'debug');
    const chipInfo = await loader.main();
    log(`Chip detected: ${chipInfo ?? '(unknown)'}`, 'ok');

    $('status').textContent = 'Connected';
    $('status').setAttribute('icon', 'link');

    await readPartitions();
  } catch (e) {
    log(`Connect failed: ${e.message}`, 'error');
  }
});

// ── File selection ────────────────────────────────────────────────────────────

$('files').addEventListener('change', () => {
  const list = $('fileList');
  list.innerHTML = '';
  const files = [...$('files').files];
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  files.forEach(f => {
    const item = document.createElement('mdui-list-item');
    item.setAttribute('icon', 'insert_drive_file');
    item.textContent = `${f.name}  —  ${fmtBytes(f.size)}`;
    list.appendChild(item);
  });

  log(`Files selected: ${files.length} file(s), total ${fmtBytes(totalSize)}`, 'info');
});

// ── Build ─────────────────────────────────────────────────────────────────────

$('build').addEventListener('click', async () => {
  try {
    const files = [...$('files').files];
    if (!files.length) throw new Error('No files selected.');

    const blockSize  = 4096;
    const blockCount = Math.floor(partition.size / blockSize);
    log(`Building LittleFS image: blockSize=${blockSize}, blockCount=${blockCount} (${fmtBytes(partition.size)})`, 'info');

    const fs = await createLittleFS({ blockSize, blockCount });
    log('LittleFS WASM module initialised', 'debug');

    for (const f of files) {
      log(`  Adding file: /${f.name}  (${fmtBytes(f.size)})`, 'debug');
      const data = new Uint8Array(await f.arrayBuffer());
      fs.addFile('/' + f.name, data);
    }

    image = fs.toImage();
    log(`Image built: ${fmtBytes(image.length)} used of ${fmtBytes(partition.size)} (${(image.length / partition.size * 100).toFixed(1)} %)`, 'ok');

    if (image.length > partition.size) throw new Error(
      `Image size ${fmtBytes(image.length)} exceeds partition size ${fmtBytes(partition.size)}.`
    );

    $('image').textContent =
      `Image size : ${fmtBytes(image.length)}\n` +
      `Partition  : ${fmtBytes(partition.size)}\n` +
      `Used       : ${(image.length / partition.size * 100).toFixed(1)} %`;

    $('write').disabled = false;
    setProgress(0, 'Ready to flash.');
  } catch (e) {
    log(`Build error: ${e.message}`, 'error');
  }
});

// ── Write ─────────────────────────────────────────────────────────────────────

$('write').addEventListener('click', async () => {
  try {
    if (!image) throw new Error('Build an image first.');

    log('──────────────────────────────────────────────────', 'info');
    log(`Starting erase+write sequence`, 'info');
    log(`  Target partition : "${partition.label}"`, 'info');
    log(`  Offset           : ${hex(partition.offset)}`, 'info');
    log(`  Partition size   : ${fmtBytes(partition.size)}`, 'info');
    log(`  Image size       : ${fmtBytes(image.length)}`, 'info');

    // ── Erase ──
    log(`Erasing ${fmtBytes(partition.size)} at ${hex(partition.offset)}…`, 'info');
    setProgress(0, 'Erasing…');
    await loader.eraseRegion(partition.offset, partition.size);
    log('Erase complete', 'ok');

    // ── Write in chunks ──
    const CHUNK = 0x4000;   // 16 KiB
    const totalChunks = Math.ceil(image.length / CHUNK);
    log(`Writing ${fmtBytes(image.length)} in ${totalChunks} chunk(s) of ${fmtBytes(CHUNK)}…`, 'info');

    let bytesWritten = 0;
    for (let i = 0; i < image.length; i += CHUNK) {
      const chunkIndex = Math.floor(i / CHUNK) + 1;
      const data = image.slice(i, i + CHUNK);

      log(`  Chunk ${chunkIndex}/${totalChunks}  address=${hex(partition.offset + i)}  size=${fmtBytes(data.length)}`, 'debug');

      await loader.writeFlash({
        fileArray: [{ address: partition.offset + i, data }],
        flashSize:  'keep',
        flashMode:  'keep',
        flashFreq:  'keep',
        eraseAll:   false,
        compress:   true,
        reportProgress: (_idx, written, _total) => {
          bytesWritten = i + written;
          const pct = Math.round(bytesWritten / image.length * 100);
          setProgress(pct, `Writing… ${pct} %  (${fmtBytes(bytesWritten)} / ${fmtBytes(image.length)})`);
        },
      });
    }

    setProgress(100, 'Flash complete ✔');
    log('Write complete — reset the device to boot from the new filesystem.', 'ok');
    log('──────────────────────────────────────────────────', 'info');
  } catch (e) {
    log(`Write error: ${e.message}`, 'error');
  }
});

// ── Clear log ─────────────────────────────────────────────────────────────────

$('clearLog').addEventListener('click', () => {
  $('log').textContent = '';
  log('Log cleared.', 'debug');
});
