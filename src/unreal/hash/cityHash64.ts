/**
 * CityHash64 — ported from Engine/Source/Runtime/Core/Private/Hash/CityHash.cpp
 * (little-endian unaligned reads; matches UE `CityHash64(const char*, uint32)`).
 */

const k0 = 0xc3a5c85c97cb3127n;
const k1 = 0xb492b66fbe98f273n;
const k2 = 0x9ae16a3b2f90404fn;

function u64(x: bigint): bigint {
  return x & 0xffffffffffffffffn;
}

function rot64(val: bigint, shift: number): bigint {
  if (shift === 0) {
    return u64(val);
  }
  return u64((val >> BigInt(shift)) | (val << BigInt(64 - shift)));
}

function shiftMix(val: bigint): bigint {
  return u64(val ^ (val >> 47n));
}

function fetch64(buf: Buffer, pos: number): bigint {
  return buf.readBigUInt64LE(pos);
}

function fetch32(buf: Buffer, pos: number): bigint {
  return BigInt(buf.readUInt32LE(pos));
}

function hashLen16(u: bigint, v: bigint): bigint {
  const kMul = 0x9ddfea08eb382d69n;
  let a = u64(u ^ v) * kMul;
  a = u64(a ^ (a >> 47n));
  let b = u64(v ^ a) * kMul;
  b = u64(b ^ (b >> 47n));
  return u64(b * kMul);
}

function hashLen16Mul(u: bigint, v: bigint, mul: bigint): bigint {
  let a = u64(u ^ v) * mul;
  a = u64(a ^ (a >> 47n));
  let b = u64(v ^ a) * mul;
  b = u64(b ^ (b >> 47n));
  return u64(b * mul);
}

function weakHashLen32WithSeeds(
  w: bigint,
  x: bigint,
  y: bigint,
  z: bigint,
  a: bigint,
  b: bigint,
): { lo: bigint; hi: bigint } {
  a = u64(a + w);
  b = u64(rot64(u64(b + a + z), 21));
  const c = a;
  a = u64(a + x);
  a = u64(a + y);
  b = u64(b + rot64(a, 44));
  return { lo: u64(a + z), hi: u64(b + c) };
}

function weakHashLen32WithSeedsBuf(buf: Buffer, pos: number, a: bigint, b: bigint): { lo: bigint; hi: bigint } {
  return weakHashLen32WithSeeds(
    fetch64(buf, pos),
    fetch64(buf, pos + 8),
    fetch64(buf, pos + 16),
    fetch64(buf, pos + 24),
    a,
    b,
  );
}

function hashLen0to16(buf: Buffer, len: number): bigint {
  if (len >= 8) {
    const mul = u64(k2 + BigInt(len) * 2n);
    const a = u64(fetch64(buf, 0) + k2);
    const b = fetch64(buf, len - 8);
    const c = u64(rot64(b, 37) * mul + a);
    const d = u64(rot64(a, 25) + b) * mul;
    return hashLen16Mul(c, d, mul);
  }
  if (len >= 4) {
    const mul = u64(k2 + BigInt(len) * 2n);
    const a = fetch32(buf, 0);
    return hashLen16Mul(u64(BigInt(len) + (a << 3n)), fetch32(buf, len - 4), mul);
  }
  if (len > 0) {
    const a = BigInt(buf.readUInt8(0));
    const b = BigInt(buf.readUInt8(len >> 1));
    const c = BigInt(buf.readUInt8(len - 1));
    const y = u64(a + (b << 8n));
    const z = BigInt(len) + (c << 2n);
    return u64(shiftMix(u64(y * k2 ^ z * k0)) * k2);
  }
  return k2;
}

function hashLen17to32(buf: Buffer, len: number): bigint {
  const mul = u64(k2 + BigInt(len) * 2n);
  const a = u64(fetch64(buf, 0) * k1);
  const b = fetch64(buf, 8);
  const c = u64(fetch64(buf, len - 8) * mul);
  const d = u64(fetch64(buf, len - 16) * k2);
  return hashLen16Mul(
    u64(rot64(u64(a + b), 43) + rot64(c, 30) + d),
    u64(a + rot64(u64(b + k2), 18) + c),
    mul,
  );
}

function bswap64(x: bigint): bigint {
  let v = u64(x);
  let o = 0n;
  for (let i = 0; i < 8; i++) {
    o = (o << 8n) | (v & 0xffn);
    v >>= 8n;
  }
  return u64(o);
}

function hashLen33to64(buf: Buffer, len: number): bigint {
  const mul = u64(k2 + BigInt(len) * 2n);
  const a = u64(fetch64(buf, 0) * k2);
  const b = fetch64(buf, 8);
  const c = fetch64(buf, len - 24);
  const d = fetch64(buf, len - 32);
  const e = u64(fetch64(buf, 16) * k2);
  const f = u64(fetch64(buf, 24) * 9n);
  const g = fetch64(buf, len - 8);
  const h = u64(fetch64(buf, len - 16) * mul);
  const u = u64(rot64(u64(a + g), 43) + u64(rot64(b, 30) + c) * 9n);
  const v = u64(u64(a + g) ^ d) + f + 1n;
  const w = u64(bswap64(u64(u + v) * mul) + h);
  const x = u64(rot64(u64(e + f), 42) + c);
  const y = u64(bswap64(u64(v + w) * mul) + g) * mul;
  const z = u64(e + f + c);
  let aOut = u64(bswap64(u64(x + z) * mul + y) + b);
  let bOut = u64(shiftMix(u64(z + aOut) * mul + d + h) * mul);
  return u64(bOut + x);
}

/** `CityHash64` from UE Core (byte buffer, arbitrary length). */
export function cityHash64(buf: Buffer): bigint {
  const len = buf.length;
  if (len <= 16) {
    return hashLen0to16(buf, len);
  }
  if (len <= 32) {
    return hashLen17to32(buf, len);
  }
  if (len <= 64) {
    return hashLen33to64(buf, len);
  }

  let x = fetch64(buf, len - 40);
  let y = u64(fetch64(buf, len - 16) + fetch64(buf, len - 56));
  let z = hashLen16(u64(fetch64(buf, len - 48) + BigInt(len)), fetch64(buf, len - 24));
  let v = weakHashLen32WithSeedsBuf(buf, len - 64, BigInt(len), z);
  let w = weakHashLen32WithSeedsBuf(buf, len - 32, u64(y + k1), x);
  x = u64(x * k1 + fetch64(buf, 0));

  let lenRem = (len - 1) & ~63;
  let s = 0;
  while (lenRem !== 0) {
    x = u64(rot64(u64(x + y + v.lo + fetch64(buf, s + 8)), 37) * k1);
    y = u64(rot64(u64(y + v.hi + fetch64(buf, s + 48)), 42) * k1);
    x = u64(x ^ w.hi);
    y = u64(y + v.lo + fetch64(buf, s + 40));
    z = u64(rot64(z + w.lo, 33) * k1);
    v = weakHashLen32WithSeedsBuf(buf, s, u64(v.hi * k1), u64(x + w.lo));
    w = weakHashLen32WithSeedsBuf(buf, s + 32, u64(z + w.hi), u64(y + fetch64(buf, s + 16)));
    const zt = z;
    z = x;
    x = zt;
    s += 64;
    lenRem -= 64;
  }
  return hashLen16(
    u64(hashLen16(v.lo, w.lo) + shiftMix(y) * k1 + z),
    u64(hashLen16(v.hi, w.hi) + x),
  );
}
