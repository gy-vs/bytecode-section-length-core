export type Op = { offset: number; opcode: number; operand?: number };

export function decode(code: Uint8Array) {
  const out: Op[] = [];
  for (let at = 0; at < code.length;) {
    const opcode = code[at++];
    if (opcode === 1) {
      if (at >= code.length) throw new Error('truncated');
      out.push({ offset: at - 1, opcode, operand: code[at++] });
    } else {
      out.push({ offset: at - 1, opcode });
    }
  }
  return out;
}

export function boundaries(code: Uint8Array) {
  return new Set(decode(code).map(op => op.offset));
}

const U32_MAX = 0xffff_ffff;
const FUNCTION_TYPE = 0x60;
const OP_OPERAND_U8 = 0x01;
const OP_BLOCK = 0x02;
const OP_END = 0x0b;
const VALID_VALUE_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c]);
const STANDARD_SECTIONS = new Map([
  [1, 'type'],
  [2, 'function'],
  [3, 'code'],
]);

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class BytecodeParseError extends Error {
  override name = 'BytecodeParseError';
  readonly offset?: number;

  constructor(message: string, options: { offset?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.offset = options.offset;
  }
}

function checkedAdd(a: number, b: number, what: string, offset: number): number {
  if (
    !Number.isSafeInteger(a) ||
    !Number.isSafeInteger(b) ||
    a < 0 ||
    b < 0 ||
    a > U32_MAX ||
    b > U32_MAX
  ) {
    throw new BytecodeParseError(`Overflow while calculating ${what}`, { offset });
  }

  if (a > U32_MAX - b) {
    throw new BytecodeParseError(`Overflow while calculating ${what}`, { offset });
  }

  return a + b;
}

class Cursor {
  constructor(
    readonly source: Uint8Array,
    readonly start: number,
    readonly end: number,
  ) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.length ||
      end > U32_MAX
    ) {
      throw new BytecodeParseError('Cursor range is outside its input', { offset: start });
    }
    this.pos = start;
  }

  pos: number;

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  eof(): boolean {
    return this.pos === this.end;
  }

  readU8(what: string): number {
    if (this.pos >= this.end) {
      throw new BytecodeParseError(`Unexpected end of data while reading ${what}`, {
        offset: this.pos,
      });
    }
    return this.source[this.pos++];
  }

  readVaruint32(what: string): number {
    const start = this.pos;
    let value = 0;

    for (let byteIndex = 0; ; byteIndex++) {
      const byte = this.readU8(what);

      if (byteIndex === 4) {
        // A five-byte u32 LEB128 can only use the low four bits.
        if ((byte & 0xf0) !== 0 || (byte & 0x80) !== 0) {
          throw new BytecodeParseError(`Overflow in ${what} varuint32`, { offset: start });
        }

        value += (byte & 0x0f) * 2 ** 28;

        // A zero final byte means the same value had a shorter canonical encoding.
        if (byte === 0) {
          throw new BytecodeParseError(`Non-canonical ${what} varuint32`, { offset: start });
        }
        break;
      }

      value += (byte & 0x7f) * 2 ** (byteIndex * 7);

      if ((byte & 0x80) === 0) {
        if (byteIndex > 0 && byte === 0) {
          throw new BytecodeParseError(`Non-canonical ${what} varuint32`, { offset: start });
        }
        break;
      }
    }

    return value;
  }

  sub(length: number, what: string): Cursor {
    const childStart = this.pos;
    const childEnd = checkedAdd(childStart, length, `${what} end offset`, childStart);

    if (childEnd > this.end) {
      throw new BytecodeParseError(
        `${what} needs ${length} byte(s), but only ${this.end - childStart} remain`,
        { offset: childStart },
      );
    }

    return new Cursor(this.source, childStart, childEnd);
  }

  takeSub(length: number, what: string): Cursor {
    const child = this.sub(length, what);
    this.pos = child.end;
    return child;
  }

  takeBytes(length: number, what: string): Uint8Array {
    const child = this.takeSub(length, what);
    return child.source.slice(child.start, child.end);
  }

  rest(): Uint8Array {
    const bytes = this.source.slice(this.pos, this.end);
    this.pos = this.end;
    return bytes;
  }

  expectEnd(what: string): void {
    if (!this.eof()) {
      throw new BytecodeParseError(
        `${what} has ${this.remaining} unexpected trailing byte(s)`,
        { offset: this.pos },
      );
    }
  }
}

function readVector<T>(
  cursor: Cursor,
  label: string,
  readItem: (index: number) => T,
): T[] {
  const count = cursor.readVaruint32(`${label} count`);
  const items: T[] = [];

  for (let index = 0; index < count; index++) {
    items.push(readItem(index));
  }

  return items;
}

function readValueType(cursor: Cursor, what: string): number {
  const type = cursor.readU8(what);
  if (!VALID_VALUE_TYPES.has(type)) {
    throw new BytecodeParseError(`Invalid value type 0x${type.toString(16)} in ${what}`, {
      offset: cursor.offset - 1,
    });
  }
  return type;
}

export interface LocalGroup {
  count: number;
  valueType: number;
}

export interface FuncType {
  params: number[];
  results: number[];
}

export interface FunctionBody {
  offset: number;
  headerSize: number;
  contentOffset: number;
  contentSize: number;
  locals: LocalGroup[];
  ops: Op[];
  raw: Uint8Array;
}

interface SectionBase {
  id: number;
  offset: number;
  headerSize: number;
  contentOffset: number;
  contentSize: number;
  raw: Uint8Array;
}

export interface CustomSection extends SectionBase {
  kind: 'custom';
  name: string;
  data: Uint8Array;
}

export interface UnknownSection extends SectionBase {
  kind: 'unknown';
}

export interface TypeSection extends SectionBase {
  kind: 'type';
  types: FuncType[];
}

export interface FunctionSection extends SectionBase {
  kind: 'function';
  typeIndices: number[];
}

export interface CodeSection extends SectionBase {
  kind: 'code';
  bodies: FunctionBody[];
}

export type Section =
  | CustomSection
  | UnknownSection
  | TypeSection
  | FunctionSection
  | CodeSection;

export interface BytecodeModule {
  sections: Section[];
  customSections: CustomSection[];
  functionBodies: FunctionBody[];
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (cause) {
    throw new BytecodeParseError(`${what} is not valid UTF-8`, { cause });
  }
}

function parseCustomSection(payload: Cursor): Omit<CustomSection, keyof SectionBase> {
  const nameLength = payload.readVaruint32('custom section name length');
  const name = decodeUtf8(payload.takeBytes(nameLength, 'custom section name'), 'custom section name');

  // Everything after the name is custom data. It is preserved verbatim and
  // never interpreted by this parser.
  return {
    kind: 'custom',
    name,
    data: payload.rest(),
  };
}

function parseTypeSection(payload: Cursor): Omit<TypeSection, keyof SectionBase> {
  const types = readVector(payload, 'type', () => {
    const form = payload.readU8('function type form');
    if (form !== FUNCTION_TYPE) {
      throw new BytecodeParseError(
        `Expected function type form 0x60, got 0x${form.toString(16)}`,
        { offset: payload.offset - 1 },
      );
    }

    const params = readVector(payload, 'parameter type', () =>
      readValueType(payload, 'parameter type'),
    );
    const results = readVector(payload, 'result type', () =>
      readValueType(payload, 'result type'),
    );

    return { params, results };
  });

  payload.expectEnd('type section');
  return { kind: 'type', types };
}

function parseFunctionSection(
  payload: Cursor,
): Omit<FunctionSection, keyof SectionBase> {
  const typeIndices = readVector(payload, 'function', index =>
    payload.readVaruint32(`function ${index} type index`),
  );

  payload.expectEnd('function section');
  return { kind: 'function', typeIndices };
}

function parseFunctionBody(code: Cursor): FunctionBody {
  const bodyOffset = code.offset;
  const bodySize = code.readVaruint32('function body size');
  const body = code.takeSub(bodySize, 'function body');
  const headerSize = body.start - bodyOffset;

  let totalLocals = 0;
  const locals = readVector(body, 'local declaration', () => {
    const count = body.readVaruint32('local count');
    totalLocals = checkedAdd(totalLocals, count, 'total local count', body.offset);
    const valueType = readValueType(body, 'local type');
    return { count, valueType };
  });

  const ops: Op[] = [];
  let blockDepth = 0;

  while (true) {
    const opOffset = body.offset - body.start;
    const opcode = body.readU8('instruction opcode');
    const op: Op = { offset: opOffset, opcode };

    if (opcode === OP_OPERAND_U8) {
      op.operand = body.readU8('u8 instruction operand');
    } else if (opcode === OP_BLOCK) {
      op.operand = body.readU8('block type');
      blockDepth = checkedAdd(blockDepth, 1, 'block nesting depth', body.offset);
    }

    if (opcode === OP_END) {
      ops.push(op);
      if (blockDepth === 0) break;
      blockDepth--;
    } else {
      ops.push(op);
    }
  }

  body.expectEnd('function body');

  return {
    offset: bodyOffset,
    headerSize,
    contentOffset: body.start,
    contentSize: body.end - body.start,
    locals,
    ops,
    raw: body.source.slice(body.start, body.end),
  };
}

function parseCodeSection(payload: Cursor): Omit<CodeSection, keyof SectionBase> {
  const bodies = readVector(payload, 'function body', () => parseFunctionBody(payload));
  payload.expectEnd('code section');
  return { kind: 'code', bodies };
}

function parseStandardSection(
  base: SectionBase,
  payload: Cursor,
): TypeSection | FunctionSection | CodeSection {
  switch (base.id) {
    case 1:
      return { ...base, ...parseTypeSection(payload) };
    case 2:
      return { ...base, ...parseFunctionSection(payload) };
    case 3:
      return { ...base, ...parseCodeSection(payload) };
    default:
      throw new BytecodeParseError(`Unsupported standard section id ${base.id}`, {
        offset: base.offset,
      });
  }
}

export function parseModule(source: Uint8Array): BytecodeModule {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError('Expected a Uint8Array');
  }

  const moduleCursor = new Cursor(source, 0, source.length);
  const sections: Section[] = [];
  const customSections: CustomSection[] = [];
  const functionBodies: FunctionBody[] = [];
  const seenStandardSections = new Set<number>();
  let previousStandardSection = 0;
  let sectionIndex = 0;

  while (!moduleCursor.eof()) {
    const sectionOffset = moduleCursor.offset;
    let id = -1;

    try {
      id = moduleCursor.readU8('section id');
      const contentSize = moduleCursor.readVaruint32('section length');

      // The section cursor is created before internal parsing. Its end is the
      // declared section boundary, so a child parser can never read the next
      // section's header as if it were section content.
      const payload = moduleCursor.takeSub(contentSize, 'section payload');
      const base: SectionBase = {
        id,
        offset: sectionOffset,
        headerSize: payload.start - sectionOffset,
        contentOffset: payload.start,
        contentSize,
        raw: source.slice(payload.start, payload.end),
      };

      let section: Section;

      if (id === 0) {
        section = { ...base, ...parseCustomSection(payload) };
        customSections.push(section);
      } else if (STANDARD_SECTIONS.has(id)) {
        if (seenStandardSections.has(id)) {
          throw new BytecodeParseError(
            `Duplicate standard section id ${id} (${STANDARD_SECTIONS.get(id)})`,
            { offset: sectionOffset },
          );
        }
        if (id < previousStandardSection) {
          throw new BytecodeParseError(
            `Standard section id ${id} appears after section id ${previousStandardSection}`,
            { offset: sectionOffset },
          );
        }

        seenStandardSections.add(id);
        previousStandardSection = id;
        section = parseStandardSection(base, payload);

        if (section.kind === 'code') {
          functionBodies.push(...section.bodies);
        }
      } else {
        // Unknown sections are retained byte-for-byte. Their contents are not
        // validated, but their declared outer boundary still is.
        section = { ...base, kind: 'unknown' };
      }

      sections.push(section);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const where = id < 0 ? 'truncated section header' : `id ${id}`;
      throw new BytecodeParseError(
        `Section ${sectionIndex} (${where}) at offset ${sectionOffset} is invalid: ${reason}`,
        { offset: sectionOffset, cause },
      );
    }

    sectionIndex++;
  }

  return { sections, customSections, functionBodies };
}
