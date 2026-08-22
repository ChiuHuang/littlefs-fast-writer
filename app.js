import { ESPLoader, Transport } from 'https://cdn.jsdelivr.net/npm/esptool-js@0.5.7/bundle.js';
import { createLittleFS, createLittleFSFromImage } from './wasm/index.js';

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

/**
 * Log the error AND show an MDUI dialog popup.
 * @param {string} title   Short title shown as dialog headline
 * @param {string} detail  Full error message / detail text
 */
function showError(title, detail) {
  log(`${title}: ${detail}`, 'error');
  // mdui.dialog is available from mdui.global.js
  mdui.dialog({
    headline: title,
    description: detail,
    actions: [{ text: 'Dismiss' }],
  });
}

function hex(n) { return '0x' + n.toString(16).toUpperCase().padStart(8, '0'); }

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1048576).toFixed(2)} MiB`;
}

function setProgress(pct, label = '') {
  $('progress').value = pct / 100;   // mdui-linear-progress uses 0–1
  $('progressLabel').textContent = label;
}

/**
 * Convert a Uint8Array to a binary string.
 * esptool-js requires data as a binary string (calls .charCodeAt internally).
 */
function toBinaryString(u8) {
  let s = '';
  // Process in 8 KiB slices to avoid call-stack overflow on large arrays
  const SLICE = 8192;
  for (let i = 0; i < u8.length; i += SLICE) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + SLICE));
  }
  return s;
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

    // Connect initially at 921600 to get partition map
    const initialBaud = 921600;
    
    // We store the port object globally so we can reconnect on write
    window.esptoolPort = port;

    transport = new Transport(port);
    loader = new ESPLoader({
      transport,
      baudrate: initialBaud,
      terminal: {
        clean() {},
        writeLine: m => log(`[esptool] ${m}`, 'debug'),
        write:     m => log(`[esptool] ${String(m)}`, 'debug'),
      },
    });

    log(`Testing connection at ${initialBaud} baud…`, 'debug');
    const chipInfo = await loader.main();
    window.connectedMac = await loader.chip.readMac(loader);
    log(`Chip detected: ${chipInfo ?? '(unknown)'}`, 'ok');
    log(`MAC Address: ${window.connectedMac}`, 'ok');
    log(`Successfully connected at ${initialBaud} baud!`, 'ok');

    $('status').textContent = 'Connected';
    $('status').setAttribute('icon', 'link');

    await readPartitions();
  } catch (e) {
    if (transport) await transport.disconnect();
    showError('Connect failed', e.message);
  }
});

// ── File selection ────────────────────────────────────────────────────────────

let selectedFiles = []; // Array of { file, targetPath }

function handleFilesSelected(event) {
  const list = $('fileList');
  if (event.target.id === 'files') {
    list.innerHTML = '';
    selectedFiles = [];
  }
  
  const files = [...event.target.files];
  
  for (const f of files) {
    let targetPath = f.name;
    if (f.webkitRelativePath) {
      // webkitRelativePath is "folderName/sub/file.txt". We strip the top-level "folderName/".
      const parts = f.webkitRelativePath.split('/');
      if (parts.length > 1) {
        parts.shift(); // remove "folderName"
        targetPath = parts.join('/');
      } else {
        targetPath = f.webkitRelativePath;
      }
    }
    
    selectedFiles.push({ file: f, targetPath });
    
    const item = document.createElement('mdui-list-item');
    item.setAttribute('icon', 'insert_drive_file');
    item.textContent = `${targetPath}  —  ${fmtBytes(f.size)}`;
    list.appendChild(item);
  }

  const totalSize = selectedFiles.reduce((s, f) => s + f.file.size, 0);
  log(`Files selected: ${selectedFiles.length} file(s), total ${fmtBytes(totalSize)}`, 'info');
}

$('files').addEventListener('change', handleFilesSelected);
$('folder').addEventListener('change', handleFilesSelected);

// ── Build ─────────────────────────────────────────────────────────────────────

$('build').addEventListener('click', async () => {
  try {
    if (!selectedFiles.length) throw new Error('No files selected.');
    
    const blockSize    = 4096;
    const blockCount   = Math.floor(partition.size / blockSize);
    // lookaheadSize must be a multiple of 8; scale with blockCount, clamp to [32, 512]
    const lookaheadSize = Math.min(512, Math.max(32, Math.ceil(blockCount / 8) * 8));
    log(`Building LittleFS image: blockSize=${blockSize}, blockCount=${blockCount}, lookaheadSize=${lookaheadSize} (${fmtBytes(partition.size)})`, 'info');

    // formatOnInit=true is required: without it the WASM tries to mount a blank
    // buffer which always returns LFS_ERR_CORRUPT (-84).
    const fs = await createLittleFS({ blockSize, blockCount, lookaheadSize, formatOnInit: true });
    log('LittleFS WASM module initialised and formatted', 'debug');

    const doPrepend = $('prependSlash').checked;
    for (const item of selectedFiles) {
      // Create parent directories if needed
      const parts = item.targetPath.split('/');
      let currentPath = '';
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += (currentPath ? '/' : '') + parts[i];
        try { fs.mkdir(currentPath); } catch(e) { /* ignore */ }
      }
      
      const finalPath = doPrepend ? '/' + item.targetPath : item.targetPath;
      log(`  Adding file: ${finalPath}  (${fmtBytes(item.file.size)})`, 'debug');
      const data = new Uint8Array(await item.file.arrayBuffer());
      fs.addFile(finalPath, data);
    }

    // Unmount flushes the LittleFS cache/lookahead/superblock to the RAM image buffer
    fs.unmount();
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
    $('listContents').disabled = false;
    setProgress(0, 'Ready to flash.');
  } catch (e) {
    showError('Build error', e.message);
  }
});

// ── Write ─────────────────────────────────────────────────────────────────────

$('write').addEventListener('click', async () => {
  try {
    if (!image) throw new Error('Build an image first.');

    log('──────────────────────────────────────────────────', 'info');
    log(`Starting write sequence`, 'info');
    
    // Auto-test logic before writing
    const lsKey = window.connectedMac ? `max-baud-${window.connectedMac}` : 'max-baud';
    if ($('autotest').checked) {
      log('Starting auto-baud stability test…', 'info');
      const testRates = [2000000, 1500000, 921600, 460800, 115200];
      let maxStable = 115200;
      
      // Disconnect current 921600 link
      if (transport) await transport.disconnect();
      
      for (const baud of testRates) {
        try {
          log(`  Testing ${baud} baud…`, 'debug');
          transport = new Transport(window.esptoolPort);
          loader = new ESPLoader({
            transport,
            baudrate: baud,
            terminal: {
              clean() {},
              writeLine: m => log(`[esptool] ${m}`, 'debug'),
              write:     m => log(`[esptool] ${String(m)}`, 'debug'),
            },
          });
          
          await loader.main();
          log(`    Connected, testing stability with 32-byte write…`, 'debug');
          
          // Test stability with 32 byte flash write at partition offset
          const dummy = toBinaryString(new Uint8Array(32).fill(0xAA));
          await loader.writeFlash({
            fileArray: [{ address: partition.offset, data: dummy }],
            flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep', eraseAll: false, compress: true,
            reportProgress: () => {}
          });
          
          maxStable = baud;
          log(`  Stable at ${baud} baud! ✔`, 'ok');
          localStorage.setItem(lsKey, baud.toString());
          $('autotest').checked = false;
          break;
        } catch (e) {
          log(`    Failed at ${baud}: ${e.message}`, 'warn');
          if (transport) await transport.disconnect();
        }
      }
      
      if (maxStable === 115200 && !$('autotest').checked === false) {
          throw new Error('Auto-test failed at all baud rates. Cannot proceed with flash.');
      }
      // Leave loader connected at maxStable
    } else {
      // Not autotesting, but let's check if we have a saved max-baud
      const savedBaud = parseInt(localStorage.getItem(lsKey), 10);
      if (savedBaud && savedBaud !== loader.baudrate) {
        log(`Reconnecting at saved max speed: ${savedBaud} baud…`, 'info');
        if (transport) await transport.disconnect();
        transport = new Transport(window.esptoolPort);
        loader = new ESPLoader({
          transport,
          baudrate: savedBaud,
          terminal: {
            clean() {},
            writeLine: m => log(`[esptool] ${m}`, 'debug'),
            write:     m => log(`[esptool] ${String(m)}`, 'debug'),
          },
        });
        await loader.main();
      }
    }

    log(`  Target partition : "${partition.label}"`, 'info');
    log(`  Offset           : ${hex(partition.offset)}`, 'info');
    log(`  Partition size   : ${fmtBytes(partition.size)}`, 'info');
    log(`  Image size       : ${fmtBytes(image.length)}`, 'info');

    // esptool-js handles deflate compression, chunking, and MD5 verification automatically.
    // It requires the data to be a binary string (calls .charCodeAt() internally).
    setProgress(0, 'Preparing image for flash…');
    const data = toBinaryString(image);

    await loader.writeFlash({
      fileArray: [{ address: partition.offset, data }],
      flashSize:  'keep',
      flashMode:  'keep',
      flashFreq:  'keep',
      eraseAll:   false,
      compress:   true,
      calculateMD5Hash: () => SparkMD5.ArrayBuffer.hash(image),
      reportProgress: (fileIndex, written, total) => {
        const pct = Math.round(written / total * 100);
        setProgress(pct, `Writing… ${pct} %  (${fmtBytes(written)} / ${fmtBytes(total)})`);
      },
    });

    setProgress(100, 'Flash complete ✔');
    log('Write complete — reset the device to boot from the new filesystem.', 'ok');
    log('─────────────────────────────', 'info');

    mdui.dialog({
      headline: 'Flash complete ✔',
      description: 'LittleFS written successfully. Reset the device to boot from the new filesystem.',
      actions: [{ text: 'OK' }],
    });
  } catch (e) {
    if (transport) await transport.disconnect();
    showError('Write error', e.message);
  }
});

// ── List Contents ─────────────────────────────────────────────────────────────

$('listContents').addEventListener('click', async () => {
  try {
    if (!image) throw new Error('Build an image first.');
    log('──────────────────────────────────────────────────', 'info');
    log('Mounting built image to list contents...', 'info');
    
    // Create a read-only instance from the binary image
    const fs = await createLittleFSFromImage(image);
    
    let fileCount = 0;
    const listDir = (path) => {
      const entries = fs.list(path);
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        
        if (entry.type === 'dir') {
          log(`  [DIR]  ${entry.path}`, 'debug');
          listDir(entry.path);
        } else {
          log(`  [FILE] ${entry.path}  (${fmtBytes(entry.size)})`, 'debug');
          fileCount++;
        }
      }
    };
    
    listDir('/');
    log(`Finished listing ${fileCount} files.`, 'ok');
    
    fs.cleanup();
  } catch (e) {
    showError('List Error', e.message);
  }
});

// ── Clear log ─────────────────────────────────────────────────────────────────

$('clearLog').addEventListener('click', () => {
  $('log').textContent = '';
  log('Log cleared.', 'debug');
});
