import { expect, it } from 'vitest';
import {
  BytecodeParseError,
  decode,
  parseModule,
  SECTION_ID,
} from '../src/index.js';

function bytes(...parts: Array<number | readonly number[] | Uint8Array>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      out.push(part);
    } else {
      out.push(...part);
    }
  }
  return Uint8Array.from(out);
}

function leb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (value !== 0);
  return out;
}

function section(id: number, payload: Array<number | readonly number[]>): Uint8Array {
  const content = bytes(...payload);
  return bytes(id, leb(content.length), content);
}

function functionBody(locals: number[], code: number[]): Uint8Array {
  const payload = bytes(locals, code);
  return bytes(leb(payload.length), payload);
}

function expectParseFailure(input: Uint8Array, message: string) {
  expect(() => parseModule(input)).toThrowError(
    new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  expect(() => parseModule(input)).toThrow(BytecodeParseError);
}

it('decodes an instruction sequence', () => {
  expect(decode(Uint8Array.from([1, 7, 0]))).toHaveLength(2);
});

it('parses sections and nested function bodies through restricted cursors', () => {
  const custom = section(SECTION_ID.CUSTOM, [leb(2), [97, 98], [7, 8, 9]]);
  const types = section(SECTION_ID.TYPE, [leb(1), leb(0), leb(0)]);
  const functions = section(SECTION_ID.FUNCTION, [leb(1), leb(0)]);
  const body = functionBody([0], [1, 7, 0]);
  const code = section(SECTION_ID.CODE, [leb(1), body]);

  const module = parseModule(bytes(custom, types, functions, code));

  expect(module.customSections).toHaveLength(1);
  expect(module.customSections[0].name).toBe('ab');
  expect(module.customSections[0].data).toEqual(Uint8Array.from([7, 8, 9]));
  expect(module.types).toEqual([{ params: [], results: [] }]);
  expect(module.functionTypeIndices).toEqual([0]);
  expect(module.bodies).toHaveLength(1);
  expect(module.bodies[0].locals).toEqual([]);
  expect(module.bodies[0].code).toEqual([
    { offset: 0, opcode: 1, operand: 7 },
    { offset: 2, opcode: 0 },
  ]);
  expect(module.bodies[0].raw).toEqual(body);
});

it('accepts zero-length unknown sections and empty function bodies', () => {
  const emptyBody = functionBody([0], [0]);
  const input = bytes(
    section(77, []),
    section(SECTION_ID.CODE, [leb(1), emptyBody]),
  );

  const module = parseModule(input);

  expect(module.unknownSections[0].header.length).toBe(0);
  expect(module.unknownSections[0].data).toEqual(new Uint8Array());
  expect(module.bodies[0].length).toBe(2);
  expect(module.bodies[0].code).toEqual([{ offset: 0, opcode: 0 }]);
});

it('rejects zero-length custom and known standard sections', () => {
  expectParseFailure(
    bytes(section(SECTION_ID.CUSTOM, [])),
    'truncated custom section name length',
  );
  expectParseFailure(
    bytes(section(SECTION_ID.TYPE, [])),
    'truncated type count varuint32',
  );
});

it('does not read the next section signature when a custom section is declared too short', () => {
  // Name length says 3, but this custom section only contains the length and 'a'.
  // The following type section signature must not be consumed as a name byte.
  const input = bytes(
    SECTION_ID.CUSTOM,
    leb(2),
    [leb(3), 97],
    section(SECTION_ID.TYPE, [leb(1), leb(0), leb(0)]),
  );

  expectParseFailure(input, 'truncated custom section name');
});

it('does not read the next section signature when a nested body is declared too short', () => {
  const nextSection = section(SECTION_ID.TYPE, [leb(1), leb(0), leb(0)]);
  // Code section contains one body. The body claims one byte, which is only the
  // local declaration count; its terminating opcode is absent.
  const input = bytes(
    section(SECTION_ID.CODE, [leb(1), leb(1), 0]),
    nextSection,
  );

  expectParseFailure(input, 'function body must end with the end opcode');
});

it('rejects sections declared longer than the module remainder', () => {
  const input = bytes(
    SECTION_ID.TYPE,
    leb(4),
    [1, 2, 3],
  );

  expectParseFailure(input, 'declares 4 bytes but only 3 remain');
});

it('rejects function bodies declared longer than their enclosing code section', () => {
  const nextSection = section(SECTION_ID.TYPE, [leb(1), leb(0), leb(0)]);
  // Code payload: one body, body length 3, but only local count + end follow.
  const input = bytes(
    section(SECTION_ID.CODE, [leb(1), leb(3), 0, 0]),
    nextSection,
  );

  expectParseFailure(input, 'function body declares 3 bytes but only 2 remain');
});

it('rejects non-canonical section and function-body length varints', () => {
  expectParseFailure(
    bytes(SECTION_ID.TYPE, 0x80, 0x00, SECTION_ID.TYPE, 0),
    'non-canonical section length varuint32',
  );

  expectParseFailure(
    section(SECTION_ID.CODE, [leb(1), 0x80, 0x00]),
    'non-canonical function body length varuint32',
  );
});

it('preserves unknown sections losslessly without parsing their contents', () => {
  const unknown = section(42, [[0x80, 0x80, 0x80]]);
  const module = parseModule(unknown);

  expect(module.unknownSections).toHaveLength(1);
  expect(module.unknownSections[0].kind).toBe('unknown');
  expect(module.unknownSections[0].data).toEqual(
    Uint8Array.from([0x80, 0x80, 0x80]),
  );
  expect(module.unknownSections[0].raw).toEqual(unknown);
});

it('allows repeated custom sections but rejects repeated standard sections', () => {
  const custom = section(SECTION_ID.CUSTOM, [leb(1), 97]);
  const types = section(SECTION_ID.TYPE, [leb(1), leb(0), leb(0)]);

  expect(parseModule(bytes(custom, custom)).customSections).toHaveLength(2);
  expectParseFailure(bytes(types, types), 'duplicate standard section 1');
});

it('rejects trailing module bytes', () => {
  const input = bytes(section(77, []), 9);

  expectParseFailure(input, 'truncated section length varuint32');
});

it('rejects trailing bytes inside known sections and function bodies', () => {
  const trailingType = bytes(SECTION_ID.TYPE, 2, 0, 99);
  expectParseFailure(trailingType, 'type section has 1 unexpected trailing byte');

  const bodyWithTrailer = functionBody([0], [0, 99]);
  const code = section(SECTION_ID.CODE, [leb(1), bodyWithTrailer]);
  expectParseFailure(
    code,
    'function body has 1 unexpected trailing byte(s)',
  );
});

it('checks nested local declaration count accumulation for overflow', () => {
  const localGroups = bytes(
    leb(2),
    leb(0xffffffff),
    1,
    leb(1),
    2,
  );
  const payload = bytes(localGroups, [0]);
  const body = bytes(leb(payload.length), payload);
  const code = section(SECTION_ID.CODE, [leb(1), body]);

  expectParseFailure(code, 'total local declaration count exceeds uint32');
});
