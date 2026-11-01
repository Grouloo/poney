// What the app needs from a GGUF file's header, without loading the model.
import fs from 'node:fs/promises';
import { isNumber } from '../unknown.ts';
import type { GgufInfo } from '../types.ts';

type GgufValue = string | number | boolean | null | GgufValue[];

const CHUNK = 1 << 20;
const MAX_ARRAY = 2048;
const FIXED: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class Reader {
  file: fs.FileHandle;
  pos: number;
  buf: Buffer;
  at: number;

  constructor(file: fs.FileHandle) { this.file = file; this.pos = 0; this.buf = Buffer.alloc(0); this.at = 0; }

  async need(n: number): Promise<void> {
    const end = this.pos + n;
    if (this.pos >= this.at && end <= this.at + this.buf.length) return;
    const size = Math.max(n, CHUNK);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await this.file.read(buf, 0, size, this.pos);
    if (bytesRead < n) throw new Error('truncated GGUF');
    this.buf = buf.subarray(0, bytesRead);
    this.at = this.pos;
  }

  async bytes(n: number): Promise<Buffer> {
    await this.need(n);
    const out = this.buf.subarray(this.pos - this.at, this.pos - this.at + n);
    this.pos += n;
    return out;
  }

  async u32() { return (await this.bytes(4)).readUInt32LE(0); }
  async u64() { return Number((await this.bytes(8)).readBigUInt64LE(0)); }
  async string() { return (await this.bytes(await this.u64())).toString('utf8'); }

  async value(type: number): Promise<GgufValue> {
    if (type === 8) return this.string();
    if (type === 9) {
      const itemType = await this.u32();
      const n = await this.u64();
      if (FIXED[itemType] && n <= MAX_ARRAY) { // (per-layer values)
        const items = [];
        for (let i = 0; i < n; i++) items.push(await this.value(itemType));
        return items;
      }
      if (FIXED[itemType]) { this.pos += n * FIXED[itemType]; return null; }
      for (let i = 0; i < n; i++) await this.value(itemType);
      return null;
    }
    const b = await this.bytes(FIXED[type]);
    return type === 4 ? b.readUInt32LE(0) : type === 5 ? b.readInt32LE(0) : type === 10 ? Number(b.readBigUInt64LE(0)) : type === 11 ? Number(b.readBigInt64LE(0)) : type === 7 ? b[0] !== 0 : null;
  }
}

/** The model's size in the header (its attention values may be per layer), or null if it is not a GGUF file. */
const number = (v: GgufValue | undefined) => (isNumber(v) ? v : null);

export async function readGguf(path: string): Promise<GgufInfo | null> {
  const file = await fs.open(path, 'r');
  try {
    const r = new Reader(file);
    if ((await r.bytes(4)).toString('latin1') !== 'GGUF') return null;
    await r.u32(); // version
    await r.u64(); // tensors
    const count = await r.u64();
    const kv: Record<string, GgufValue | undefined> = {};
    for (let i = 0; i < count; i++) {
      const key = await r.string();
      if (key.startsWith('tokenizer.')) break; // (the metadata wanted comes first; the vocabulary is long)
      kv[key] = await r.value(await r.u32());
    }
    const name = kv['general.architecture'];
    const arch = typeof name === 'string' ? name : null;
    const headCountKv = kv[`${arch}.attention.head_count_kv`];
    const slidingPattern = kv[`${arch}.attention.sliding_window_pattern`];
    return {
      arch,
      contextLength: number(kv[`${arch}.context_length`]),
      blockCount: number(kv[`${arch}.block_count`]),
      embeddingLength: number(kv[`${arch}.embedding_length`]),
      headCount: number(kv[`${arch}.attention.head_count`]),
      headCountKv: Array.isArray(headCountKv) ? headCountKv.map((v) => (isNumber(v) ? v : 0)) : number(headCountKv),
      keyLength: number(kv[`${arch}.attention.key_length`]),
      valueLength: number(kv[`${arch}.attention.value_length`]),
      slidingWindow: number(kv[`${arch}.attention.sliding_window`]),
      slidingPattern: Array.isArray(slidingPattern) ? slidingPattern.map(Boolean) : null,
      keyLengthSwa: number(kv[`${arch}.attention.key_length_swa`]),
      valueLengthSwa: number(kv[`${arch}.attention.value_length_swa`]),
    };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
