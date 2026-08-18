'use strict';
// ---------------------------------------------------------------------------
// Minimal ZIP reader (store + deflate). No zip64 / encryption / multi-disk.
// First principles: we only need to read the 6 XML members of a .lc96p file.
// ---------------------------------------------------------------------------
const zlib = require('zlib');

function readZip(buf) {
  // locate End Of Central Directory record
  let eocd = -1;
  const min = buf.length - 65557;
  for (let i = buf.length - 22; i >= Math.max(0, min); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (EOCD not found)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('Bad central directory entry #' + n);
    const method = buf.readUInt16LE(cdOffset + 10);
    const flags = buf.readUInt16LE(cdOffset + 8);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    let name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    if (!(flags & 0x0800)) { // not UTF-8 flagged: try latin1 fallback, keep utf8 decode attempt
      // keep as-is; names here are ASCII anyway
    }
    // local header
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Bad local header for ' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, { method, data });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: Array.from(entries.keys()),
    has(name) { return entries.has(name); },
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.method === 0) return Buffer.from(e.data);
      if (e.method === 8) return zlib.inflateRawSync(e.data);
      throw new Error('Unsupported zip method ' + e.method + ' for ' + name);
    },
    readText(name) {
      const b = this.read(name);
      return b ? b.toString('utf8').replace(/^\uFEFF/, '') : null;
    },
  };
}

module.exports = { readZip };