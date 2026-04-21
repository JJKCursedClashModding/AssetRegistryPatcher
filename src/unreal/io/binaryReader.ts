/** Little-endian binary reader over a Buffer. */

export class BinaryReader {
  offset = 0;

  constructor(readonly buf: Buffer) {}

  get length(): number {
    return this.buf.length;
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.buf.length) {
      throw new Error(`Seek out of range: ${pos} (len ${this.buf.length})`);
    }
    this.offset = pos;
  }

  skip(n: number): void {
    this.offset += n;
    if (this.offset > this.buf.length) {
      throw new Error("Read past end of buffer");
    }
  }

  readU8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readU32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readI32(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readU64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readI64(): bigint {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readBytes(len: number): Buffer {
    if (len < 0 || this.offset + len > this.buf.length) {
      throw new Error(`readBytes(${len}) past end`);
    }
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return Buffer.from(out);
  }

  /** Unreal FString / FUtf8String-style: int32 count then payload. */
  readUtf8StringNoWidth(): string {
    const saveNum = this.readI32();
    if (saveNum < 0) {
      throw new Error("Unexpected wide FString where UTF-8 was expected");
    }
    if (saveNum === 0) {
      return "";
    }
    const raw = this.readBytes(saveNum);
    const nul = raw.indexOf(0);
    const slice = nul >= 0 ? raw.subarray(0, nul) : raw;
    return slice.toString("utf8");
  }

  /**
   * FString as stored for TCHAR builds (Windows): negative SaveNum = UTF-16LE code units including NUL;
   * positive = ANSI bytes including NUL.
   */
  readFString(): string {
    let saveNum = this.readI32();
    if (saveNum === 0) {
      return "";
    }
    if (saveNum === -2147483648) {
      throw new Error("Corrupt FString length");
    }
    if (saveNum < 0) {
      saveNum = -saveNum;
      const raw = this.readBytes(saveNum * 2);
      let end = saveNum;
      while (end > 0 && raw.readUInt16LE((end - 1) * 2) === 0) {
        end--;
      }
      return raw.subarray(0, end * 2).toString("utf16le");
    }
    const raw = this.readBytes(saveNum);
    let end = saveNum;
    while (end > 0 && raw[end - 1] === 0) {
      end--;
    }
    return raw.subarray(0, end).toString("latin1");
  }
}
