import { describe, expect, it } from 'vitest';
import {
  BytecodeParseError,
  decode,
  parseModule,
} from '../src/index.js';

const u32 = (value: number): number[] => {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
};

const section = (id: number, payload: number[] | Uint8Array): number[] => [
  id,
  ...u32(payload.length),
  ...payload,
];

const custom = (name: string, data: number[] = []): number[] => {
  const nameBytes = [...new TextEncoder().encode(name)];
  return section(0, [...u32(nameBytes.length), ...nameBytes, ...data]);
};

const body = (content: number[]): number[] => [...u32(content.length), ...content];

const bytes = (...parts: number[][]): Uint8Array =>
  Uint8Array.from(parts.flat());

describe('legacy opcode decoder', () => {
  it('decodes', () => expect(decode(Uint8Array.from([1, 7, 0]))).toHaveLength(2));
});

describe('parseModule', () => {
  it('accepts an empty module', () => {
    const parsed = parseModule(new Uint8Array());
    expect(parsed.sections).toEqual([]);
    expect(parsed.functionBodies).toEqual([]);
  });

  it('accepts zero-length unknown sections and zero-count standard sections', () => {
    const parsed = parseModule(bytes(
      section(99, []),
      section(1, [0]),
      section(2, [0]),
      section(3, [0]),
    ));

    expect(parsed.sections.map(s => s.kind)).toEqual([
      'unknown',
      'type',
      'function',
      'code',
    ]);
    expect(parsed.sections[0]).toMatchObject({
      id: 99,
      contentOffset: 2,
      contentSize: 0,
    });
  });

  it('preserves unknown sections without interpreting their contents', () => {
    const payload = [0xff, 0xff, 0x00];
    const parsed = parseModule(bytes(section(42, payload)));

    expect(parsed.sections[0].kind).toBe('unknown');
    expect(parsed.sections[0].raw).toEqual(Uint8Array.from(payload));
  });

  it('preserves custom section tails without parsing them', () => {
    const parsed = parseModule(bytes(custom('x', [0xde, 0xad])));

    expect(parsed.customSections).toHaveLength(1);
    expect(parsed.customSections[0]).toMatchObject({
      kind: 'custom',
      name: 'x',
    });
    expect(parsed.customSections[0].data).toEqual(Uint8Array.from([0xde, 0xad]));
  });

  it('parses nested function bodies with bounded cursors', () => {
    const functionContent = [
      0, // zero local declarations
      0x02, 0x7f, // block
      0x01, 7, // instruction with u8 operand
      0x0b, // end block
      0x0b, // end function
    ];
    const parsed = parseModule(bytes(
      section(3, [1, ...body(functionContent)]),
    ));

    const [fn] = parsed.functionBodies;
    expect(fn.contentSize).toBe(functionContent.length);
    expect(fn.ops.map(op => op.opcode)).toEqual([0x02, 0x01, 0x0b, 0x0b]);
    expect(fn.raw).toEqual(Uint8Array.from(functionContent));
  });

  it.each([
    ['zero-length custom section', section(0, [])],
    ['zero-length type section', section(1, [])],
    ['zero-length function section', section(2, [])],
    ['zero-length code section', section(3, [])],
    ['zero-length function body', section(3, [1, ...body([])])],
    ['a function body without its terminator', section(3, [1, ...body([0])])],
    ['trailing bytes in a function body', section(3, [1, ...body([0, 0x0b, 99])])],
  ])('rejects %s', (_name, moduleBytes) => {
    expect(() => parseModule(bytes(moduleBytes))).toThrow(BytecodeParseError);
  });

  it('does not read the next section header as short custom-section content', () => {
    const malformedCustom = [0, 2, 3, 'x'.charCodeAt(0)];
    const nextSection = section(1, [0]);

    try {
      parseModule(bytes(malformedCustom, nextSection));
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BytecodeParseError);
      expect(error).toMatchObject({ offset: 0 });
      expect((error as Error).message).toContain('id 0');
      expect((error as Error).message).not.toContain('id 1');
    }
  });

  it('does not read the next section header as short standard-section content', () => {
    const malformedType = section(1, [1]); // one type, but no type form
    const nextSection = section(2, [0]);

    try {
      parseModule(bytes(malformedType, nextSection));
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BytecodeParseError);
      expect(error).toMatchObject({ offset: 0 });
      expect((error as Error).message).toContain('id 1');
    }
  });

  it('rejects a section declaration longer than its actual payload', () => {
    // The declared length is two, but the section only supplies its count byte.
    const malformed = Uint8Array.from([1, 2, 0]);
    expect(() => parseModule(malformed)).toThrow(/only 1 remain/);
  });

  it('rejects a section length extending past module EOF', () => {
    expect(() => parseModule(Uint8Array.from([0, 9, 1, 2]))).toThrow(
      BytecodeParseError,
    );
  });

  it('does not let a short function body consume the following body header', () => {
    // Two bodies are declared. The first says it has one byte; the second
    // body's header must remain outside that restricted cursor.
    const codePayload = [
      2,
      ...body([0]), // declared one byte: only locals vector, no terminator
      ...body([0, 0x0b]),
    ];

    expect(() => parseModule(bytes(section(3, codePayload)))).toThrow(
      /Unexpected end of data while reading instruction opcode/,
    );
  });

  it('rejects non-canonical section and function-body length varints', () => {
    expect(() => parseModule(Uint8Array.from([0, 0x80, 0x00]))).toThrow(
      /Non-canonical section length/,
    );

    const nonCanonicalBodySize = section(3, [1, 0x80, 0x00]);
    expect(() => parseModule(bytes(nonCanonicalBodySize))).toThrow(
      /Non-canonical function body size/,
    );
  });

  it('rejects overflowing length varints and end-offset addition', () => {
    const overflowLength = [0, 0x80, 0x80, 0x80, 0x80, 0x10];
    expect(() => parseModule(Uint8Array.from(overflowLength))).toThrow(
      /Overflow in section length/,
    );

    const maxLengthAtNonZeroOffset = [99, ...u32(0xffff_ffff), 0];
    expect(() => parseModule(Uint8Array.from(maxLengthAtNonZeroOffset))).toThrow(
      /Overflow.*section payload end offset/,
    );
  });

  it('rejects overflowing nested local counts', () => {
    const max = u32(0xffff_ffff);
    const functionContent = [
      2, // two local groups
      ...max, 0x7f,
      1, 0x7f,
      0x0b,
    ];

    expect(() => parseModule(bytes(section(3, [1, ...body(functionContent)])))).toThrow(
      /Overflow.*total local count/,
    );
  });

  it('rejects duplicate standard sections', () => {
    expect(() => parseModule(bytes(section(1, [0]), section(1, [0])))).toThrow(
      /Duplicate standard section id 1/,
    );
  });

  it('rejects out-of-order standard sections but allows repeated custom sections', () => {
    expect(() => parseModule(bytes(
      custom('a'),
      section(2, [0]),
      custom('b'),
      section(1, [0]),
    ))).toThrow(/Standard section id 1 appears after section id 2/);
  });

  it('rejects trailing bytes that do not form a complete section', () => {
    expect(() => parseModule(bytes(section(1, [0]), [99]))).toThrow(BytecodeParseError);
  });
});
