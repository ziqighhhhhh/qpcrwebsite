'use strict';
// ---------------------------------------------------------------------------
// Export writers: CSV, JSON, XLSX (hand-rolled minimal writer, no deps).
// All exports are generated from the single experiment model.
// ---------------------------------------------------------------------------

function fmt(v, digits) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    return String(Math.round(v * Math.pow(10, digits || 6)) / Math.pow(10, digits || 6));
  }
  return String(v);
}

function wellLabel(n) {
  return String.fromCharCode(64 + Math.ceil(n / 12)) + (((n - 1) % 12) + 1);
}

// ---- rows: one per (well x dye) ----
function buildRows(exp) {
  const rows = [];
  const dyes = exp.dyes;
  for (const w of exp.wells) {
    for (const dye of dyes) {
      const key = w.id + '|' + dye;
      const curve = exp.curves.find(c => c.well === w.id && c.dye === dye);
      const comp = exp.computed[key] || {};
      const stQ = exp.storedQual[key] || null;
      const stK = exp.storedKinetic[key] || null;
      rows.push({
        Well: w.label,
        Position: w.id,
        Sample: w.sampleName || '',
        SampleType: w.sampleType || '',
        Dye: dye,
        Channel: exp.channelOf[dye],
        Call: comp['11 Intermediate Call'] !== undefined ? comp['11 Intermediate Call'] : (stQ ? stQ.call : ''),
        Cq: comp['26 CT1'] !== undefined ? fmt(comp['26 CT1'], 2) : (stQ && stQ.cq !== undefined ? fmt(stQ.cq, 2) : ''),
        Slope: comp['23 MRS'] !== undefined ? fmt(comp['23 MRS'], 4) : (stQ && stQ.slope !== undefined ? fmt(stQ.slope, 4) : (stK ? fmt(stK.slope, 4) : '')),
        EPF: comp['78 LC96 Normalized ERI'] !== undefined ? fmt(comp['78 LC96 Normalized ERI'], 6) : (stQ && stQ.epf !== undefined ? fmt(stQ.epf, 6) : ''),
        CombinedResult: stQ ? (stQ.combinedResult || '') : '',
        Failure: stQ ? (stQ.failureType || '') : '',
        StoredCall: stQ ? stQ.call : '',
        StoredCq: stQ && stQ.cq !== undefined ? fmt(stQ.cq, 2) : '',
        OptimalModel: comp['41 Optimal Model'] !== undefined ? comp['41 Optimal Model'] : (stK ? stK.optimalModel : ''),
        Validity: comp['42 Validity Value'] !== undefined ? fmt(comp['42 Validity Value'], 4) : '',
        SNR: comp['48 Signal To Noise'] !== undefined ? fmt(comp['48 Signal To Noise'], 2) : '',
        AmpEfficiency: comp['49 Amplification Efficiency'] !== undefined ? fmt(comp['49 Amplification Efficiency'], 4) : '',
        Outliers: comp['61 Number Of Outliers'] !== undefined ? comp['61 Number Of Outliers'] : '',
        Iterations: comp['62 Number Of Iterations'] !== undefined ? comp['62 Number Of Iterations'] : '',
        AllParams: JSON.stringify(comp),
      });
    }
  }
  return rows;
}

function toCSV(exp) {
  const rows = buildRows(exp);
  if (!rows.length) return Buffer.from('', 'utf8');
  const cols = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  // BOM so Excel opens UTF-8 correctly
  return Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(lines.join('\r\n'), 'utf8')]);
}

function toJSON(exp) {
  return Buffer.from(JSON.stringify(exp, null, 2), 'utf8');
}

// ---- minimal XLSX writer (single sheet, inline strings, stored zip) ----
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);   // UTF-8 names
    lh.writeUInt16LE(0, 8);        // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    chunks.push(lh, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  chunks.push(Buffer.concat(central), eocd);
  return Buffer.concat(chunks);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toXLSX(exp) {
  const rows = buildRows(exp);
  const cols = Object.keys(rows[0]);
  const sheetRows = ['<sheetData>'];
  // header row
  sheetRows.push('<row r="1">' + cols.map((c, i) =>
    '<c r="' + colName(i) + '1" t="inlineStr"><is><t>' + xmlEscape(c) + '</t></is></c>').join('') + '</row>');
  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    sheetRows.push('<row r="' + rowNum + '">' + cols.map((c, i) => {
      const v = r[c];
      if (v === '' || v === null || v === undefined) return '<c r="' + colName(i) + rowNum + '"/>';
      if (typeof v === 'number') return '<c r="' + colName(i) + rowNum + '"><v>' + v + '</v></c>';
      return '<c r="' + colName(i) + rowNum + '" t="inlineStr"><is><t>' + xmlEscape(v) + '</t></is></c>';
    }).join('') + '</row>');
  });
  sheetRows.push('</sheetData>');

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    sheetRows.join('') + '</worksheet>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRels, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}

function colName(i) {
  let s = '';
  i++;
  while (i > 0) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

module.exports = { toCSV, toJSON, toXLSX, buildRows };