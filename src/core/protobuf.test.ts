import { describe, expect, it } from 'vitest';
import { ProtoReader, ProtoWriter, WIRE_FIXED32, WIRE_FIXED64, WIRE_LEN, WIRE_VARINT } from './protobuf';

const bytes = (...b: number[]) => new Uint8Array(b);
const reader = (...b: number[]) => new ProtoReader(bytes(...b));

describe('ProtoWriter', () => {
  it('writes varints little-endian, 7 bits at a time', () => {
    expect(new ProtoWriter().int(1, 1).finish()).toEqual(bytes(0x08, 0x01));
    expect(new ProtoWriter().int(1, 127).finish()).toEqual(bytes(0x08, 0x7f));
    expect(new ProtoWriter().int(1, 128).finish()).toEqual(bytes(0x08, 0x80, 0x01));
    expect(new ProtoWriter().int(1, 300).finish()).toEqual(bytes(0x08, 0xac, 0x02));
  });

  it('writes negative ints as 10-byte two’s complement', () => {
    expect(new ProtoWriter().int(1, -1).finish()).toEqual(bytes(0x08, ...Array(9).fill(0xff), 0x01));
  });

  it('encodes field number and wire type in the tag', () => {
    expect(new ProtoWriter().int(5, 1).finish()[0]).toBe((5 << 3) | WIRE_VARINT);
    expect(new ProtoWriter().int(16, 1).finish().slice(0, 2)).toEqual(bytes(0x80, 0x01));
  });

  it('omits zero ints and empty bytes/strings (proto3)', () => {
    expect(new ProtoWriter().int(1, 0).bytes(2, bytes()).string(3, '').finish()).toEqual(bytes());
  });

  it('writes length-delimited bytes and UTF-8 strings', () => {
    expect(new ProtoWriter().bytes(1, bytes(9, 8)).finish()).toEqual(bytes(0x0a, 2, 9, 8));
    expect(new ProtoWriter().string(2, 'é').finish()).toEqual(bytes(0x12, 2, 0xc3, 0xa9));
  });

  it('writes nested messages, even empty ones', () => {
    const inner = new ProtoWriter().int(1, 3);
    expect(new ProtoWriter().message(1, inner).finish()).toEqual(bytes(0x0a, 2, 0x08, 3));
    expect(new ProtoWriter().message(1, new ProtoWriter()).finish()).toEqual(bytes(0x0a, 0));
  });

  it('writes lengths over 127 as multi-byte varints', () => {
    const long = new Uint8Array(200).fill(7);
    const out = new ProtoWriter().bytes(1, long).finish();
    expect(out.slice(0, 3)).toEqual(bytes(0x0a, 0xc8, 0x01));
    expect(out).toHaveLength(203);
    const msg = new ProtoWriter().message(1, new ProtoWriter().bytes(1, long)).finish();
    expect(msg.slice(0, 3)).toEqual(bytes(0x0a, 0xcb, 0x01));
  });
});

describe('ProtoReader', () => {
  it('reads tags', () => {
    expect(reader(0x2a).tag()).toEqual({ field: 5, wire: WIRE_LEN });
    expect(reader(0x80, 0x01).tag()).toEqual({ field: 16, wire: WIRE_VARINT });
  });

  it('reads multi-byte varints', () => {
    expect(reader(0xac, 0x02).varint()).toBe(300n);
    expect(reader(...Array(9).fill(0xff), 0x01).varint()).toBe(2n ** 64n - 1n);
  });

  it('reads ints as signed 64-bit', () => {
    expect(reader(...Array(9).fill(0xff), 0x01).int()).toBe(-1);
    expect(reader(0xac, 0x02).int()).toBe(300);
  });

  it('rejects truncated and over-long varints', () => {
    expect(() => reader().varint()).toThrow('Truncated protobuf varint');
    expect(() => reader(0x80).varint()).toThrow('Truncated protobuf varint');
    expect(() => reader(...Array(10).fill(0x80), 0x01).varint()).toThrow('Protobuf varint too long');
  });

  it('reads bytes and strings', () => {
    const r = reader(2, 9, 8, 2, 0xc3, 0xa9);
    expect(r.bytes()).toEqual(bytes(9, 8));
    expect(r.string()).toBe('é');
    expect(r.eof()).toBe(true);
  });

  it('reads an exactly-fitting field and rejects a truncated one', () => {
    expect(reader(1, 7).bytes()).toEqual(bytes(7));
    expect(() => reader(2, 7).bytes()).toThrow('Truncated protobuf field');
  });

  it('tracks eof', () => {
    const r = reader(0x01);
    expect(r.eof()).toBe(false);
    r.varint();
    expect(r.eof()).toBe(true);
  });

  it('skips every supported wire type', () => {
    const cases: [number, number[]][] = [
      [WIRE_VARINT, [0x80, 0x01]],
      [WIRE_FIXED64, [1, 2, 3, 4, 5, 6, 7, 8]],
      [WIRE_LEN, [2, 1, 2]],
      [WIRE_FIXED32, [1, 2, 3, 4]],
    ];
    for (const [wire, data] of cases) {
      const r = reader(...data, 0x08, 0x2a);
      r.skip(wire);
      expect(r.tag()).toEqual({ field: 1, wire: 0 });
      expect(r.int()).toBe(42);
    }
  });

  it('skips fixed-width fields that end exactly at the end of the buffer', () => {
    const r64 = reader(1, 2, 3, 4, 5, 6, 7, 8);
    r64.skip(WIRE_FIXED64);
    expect(r64.eof()).toBe(true);
    const r32 = reader(1, 2, 3, 4);
    r32.skip(WIRE_FIXED32);
    expect(r32.eof()).toBe(true);
  });

  it('rejects truncated fixed-width fields', () => {
    expect(() => reader(1, 2, 3, 4, 5, 6, 7).skip(WIRE_FIXED64)).toThrow('Truncated protobuf field');
    expect(() => reader(1, 2, 3).skip(WIRE_FIXED32)).toThrow('Truncated protobuf field');
  });

  it('rejects unsupported wire types', () => {
    expect(() => reader().skip(3)).toThrow('Unsupported protobuf wire type 3');
  });

  it('round-trips with the writer', () => {
    const buf = new ProtoWriter().int(1, -12345).string(2, 'hello').int(3, 2 ** 40).finish();
    const r = new ProtoReader(buf);
    expect(r.tag()).toEqual({ field: 1, wire: WIRE_VARINT });
    expect(r.int()).toBe(-12345);
    expect(r.tag()).toEqual({ field: 2, wire: WIRE_LEN });
    expect(r.string()).toBe('hello');
    expect(r.tag()).toEqual({ field: 3, wire: WIRE_VARINT });
    expect(r.int()).toBe(2 ** 40);
    expect(r.eof()).toBe(true);
  });
});
