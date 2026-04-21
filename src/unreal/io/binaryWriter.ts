/** Growable little-endian buffer (UE FArchive-style append). */

export class BinaryWriter {
  private chunks: Buffer[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  private push(buf: Buffer): void {
    this.chunks.push(buf);
    this._length += buf.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this._length);
  }

  writeU8(v: number): void {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v & 0xff, 0);
    this.push(b);
  }

  writeU16(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v & 0xffff, 0);
    this.push(b);
  }

  writeI32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v, 0);
    this.push(b);
  }

  writeU32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.push(b);
  }

  writeI64(v: bigint): void {
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64LE(v, 0);
    this.push(b);
  }

  writeU64(v: bigint): void {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(v, 0);
    this.push(b);
  }

  writeBytes(buf: Buffer): void {
    this.push(Buffer.from(buf));
  }

  /** FString / narrow: positive length includes trailing NUL in stream (UE cooked ANSI path). */
  writeFStringAnsiWithNul(s: string): void {
    const body = Buffer.from(s, "latin1");
    const n = body.length + 1;
    this.writeI32(n);
    const b = Buffer.allocUnsafe(n);
    body.copy(b, 0);
    b[n - 1] = 0;
    this.push(b);
  }

  /** FUtf8String / UE UTF-8 string: length = byte count, no NUL in stream. */
  writeUtf8StringNoNul(s: string): void {
    const body = Buffer.from(s, "utf8");
    this.writeI32(body.length);
    if (body.length) {
      this.push(body);
    }
  }

  /**
   * `FString` as `FArchive` stores it on TCHAR=wchar_t targets (matches {@link BinaryReader.readFString}):
   * `SaveNum == 0` empty; `SaveNum > 0` ANSI bytes including NUL; `SaveNum < 0` UTF-16LE TCHARs including NUL.
   */
  writeFStringUE(s: string): void {
    if (s.length === 0) {
      this.writeI32(0);
      return;
    }
    let pureAnsi = true;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x7f) {
        pureAnsi = false;
        break;
      }
    }
    if (pureAnsi) {
      const body = Buffer.from(s, "latin1");
      const n = body.length + 1;
      this.writeI32(n);
      const b = Buffer.allocUnsafe(n);
      body.copy(b, 0);
      b[n - 1] = 0;
      this.push(b);
      return;
    }
    const units = s.length + 1;
    this.writeI32(-units);
    const u = Buffer.allocUnsafe(units * 2);
    for (let i = 0; i < s.length; i++) {
      u.writeUInt16LE(s.charCodeAt(i), i * 2);
    }
    u.writeUInt16LE(0, s.length * 2);
    this.push(u);
  }
}
