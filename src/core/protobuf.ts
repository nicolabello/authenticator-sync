/** Just enough protobuf to read/write Google Authenticator's MigrationPayload. */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

export class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('Truncated protobuf varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('Protobuf varint too long');
    }
  }

  /** Varint interpreted as a signed 64-bit int, returned as a JS number. */
  int(): number {
    return Number(BigInt.asIntN(64, this.varint()));
  }

  tag(): { field: number; wire: number } {
    const t = Number(this.varint());
    return { field: t >>> 3, wire: t & 7 };
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.buf.length) throw new Error('Truncated protobuf field');
    const out = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  private advance(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('Truncated protobuf field');
    this.pos += n;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.advance(8);
        return;
      case WIRE_LEN:
        this.bytes();
        return;
      case WIRE_FIXED32:
        this.advance(4);
        return;
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

export class ProtoWriter {
  private readonly out: number[] = [];

  private rawVarint(v: number | bigint): void {
    let x = BigInt.asUintN(64, BigInt(v));
    while (x >= 0x80n) {
      this.out.push(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    this.out.push(Number(x));
  }

  private tag(field: number, wire: number): void {
    this.rawVarint((field << 3) | wire);
  }

  /** proto3 semantics: zero values are omitted. */
  int(field: number, v: number): this {
    if (v !== 0) {
      this.tag(field, WIRE_VARINT);
      this.rawVarint(v);
    }
    return this;
  }

  bytes(field: number, b: Uint8Array): this {
    if (b.length === 0) return this;
    this.tag(field, WIRE_LEN);
    this.rawVarint(b.length);
    for (const x of b) this.out.push(x);
    return this;
  }

  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }

  message(field: number, w: ProtoWriter): this {
    const b = w.finish();
    this.tag(field, WIRE_LEN);
    this.rawVarint(b.length);
    for (const x of b) this.out.push(x);
    return this;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.out);
  }
}
