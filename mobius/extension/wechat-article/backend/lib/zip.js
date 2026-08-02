// 无第三方依赖的 ZIP writer。使用 deflate + data descriptor，适合文章文档和数 MB 图片。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value & 0xffff); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }

function createZip(outputPath, entries) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const chunks = [];
  const central = [];
  let offset = 0;
  const stamp = dosTime();

  for (const entry of entries || []) {
    const name = String(entry.name || "file").replace(/\\/g, "/").replace(/^\/+/, "");
    const nameBuf = Buffer.from(name, "utf8");
    const source = Buffer.isBuffer(entry.data) ? entry.data : fs.readFileSync(entry.path);
    const compressed = zlib.deflateRawSync(source, { level: 6 });
    const crc = crc32(source);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(stamp.time), u16(stamp.day),
      u32(crc), u32(compressed.length), u32(source.length), u16(nameBuf.length), u16(0), nameBuf,
    ]);
    chunks.push(local, compressed);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(stamp.time), u16(stamp.day),
      u32(crc), u32(compressed.length), u32(source.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  fs.writeFileSync(outputPath, Buffer.concat([...chunks, centralBuf, end]));
  return { path: outputPath, bytes: fs.statSync(outputPath).size, entries: central.length };
}

module.exports = { createZip, crc32 };
