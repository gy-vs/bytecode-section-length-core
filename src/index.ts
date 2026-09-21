export const SECTION_ID = {
  CUSTOM: 0,
  TYPE: 1,
  FUNCTION: 2,
  CODE: 3,
} as const;

export const END_OPCODE = 0;
export const IMMEDIATE_OPCODE = 1;

const MAX_U32 = 0xffffffff;

export type Op = {
  offset: number;
  opcode: number;
  operand?: number;
};

export type LocalsGroup = {
  count: number;
  type: number;
};

export type FunctionType = {
  params: number[];
  results: number[];
};

export type FunctionBody = {
  offset: number;
  length: number;
  contentOffset: number;
  locals: LocalsGroup[];
  code: Op[];
  raw: Uint8Array;
};

export type SectionHeader = {
  id: number;
  offset: number;
  lengthOffset: number;
  contentOffset: number;
  length: number;
  endOffset: number;
};

export type CustomSection = {
  kind: 'custom';
  header: SectionHeader;
  nameOffset: number;
  name: string;
  data: Uint8Array;
  raw: Uint8Array;
};

export type TypeSection = {
  kind: 'type';
  header: SectionHeader;
  types: FunctionType[];
  raw: Uint8Array;
};

export type FunctionSection = {
  kind: 'function';
  header: SectionHeader;
  typeIndices: number[];
  raw: Uint8Array;
};

export type CodeSection = {
  kind: 'code';
  header: SectionHeader;
  bodies: FunctionBody[];
  raw: Uint8Array;
};

export type UnknownSection = {
  kind: 'unknown';
  header: SectionHeader;
  data: Uint8Array;
  raw: Uint8Array;
};

export type Section =
  | CustomSection
  | TypeSection
  | FunctionSection
  | CodeSection
  | UnknownSection;

export type ParsedModule = {
  sections: Section[];
  customSections: CustomSection[];
  typeSection?: TypeSection;
  functionSection?: FunctionSection;
  codeSection?: CodeSection;
  unknownSections: UnknownSection[];
  types: FunctionType[];
  functionTypeIndices: number[];
  bodies: FunctionBody[];
};

export class BytecodeParseError extends Error {
  readonly offset?: number;
  readonly sectionId?: number;

  constructor(
    message: string,
    options: { offset?: number; sectionId?: number } = {},
  ) {
    super(message);
    this.name = 'BytecodeParseError';
    this.offset = options.offset;
    this.sectionId = options.sectionId;
  }
}

class BytecodeCursor {
  private constructor(
    private readonly data: Uint8Array,
    private pos: number,
    private readonly limit: number,
    private readonly sectionId?: number,
  ) {}

  static root(data: Uint8Array): BytecodeCursor {
    return new BytecodeCursor(data, 0, data.length);
  }

  get offset(): number {
    return this.pos;
  }

  get endOffset(): number {
    return this.limit;
  }

  get remaining(): number {
    return this.limit - this.pos;
  }

  get exhausted(): boolean {
    return this.pos === this.limit;
  }

  fail(message: string, offset: number = this.pos): never {
    throw new BytecodeParseError(message, { offset, sectionId: this.sectionId });
  }

  u8(what: string): number {
    if (this.pos >= this.limit) {
      this.fail(`truncated ${what}`);
    }
    return this.data[this.pos++];
  }

  varU32(what: string): number {
    const start = this.pos;
    let value = 0;

    for (let shift = 0; shift <= 28; shift += 7) {
      if (this.pos >= this.limit) {
        this.fail(`truncated ${what} varuint32`, start);
      }

      const byte = this.data[this.pos];

      if (shift === 28 && (byte & 0xf0) !== 0) {
        this.fail(`${what} varuint32 overflow`, this.pos);
      }

      value |= (byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) {
        if (shift > 0 && byte === 0) {
          this.fail(`non-canonical ${what} varuint32`, this.pos);
        }
        this.pos++;
        return value >>> 0;
      }

      this.pos++;
    }

    this.fail(`${what} varuint32 overflow`, this.pos);
  }

  take(length: number, what: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      this.fail(`invalid ${what} length`);
    }
    if (length > this.remaining) {
      this.fail(`truncated ${what}`);
    }

    const start = this.pos;
    this.pos += length;
    return this.data.slice(start, this.pos);
  }

  tail(): Uint8Array {
    const value = this.data.slice(this.pos, this.limit);
    this.pos = this.limit;
    return value;
  }

  limited(length: number, what: string): BytecodeCursor {
    if (!Number.isSafeInteger(length) || length < 0) {
      this.fail(`invalid ${what} length`);
    }
    if (length > this.remaining) {
      this.fail(
        `${what} declares ${length} bytes but only ${this.remaining} remain`,
      );
    }

    const end = checkedAdd(this.pos, length, `${what} end offset`);
    return new BytecodeCursor(this.data, this.pos, end, this.sectionId);
  }

  advanceTo(offset: number): void {
    if (offset < this.pos || offset > this.limit) {
      this.fail(`cannot advance cursor to ${offset}`);
    }
    this.pos = offset;
  }

  copyRange(start: number, end: number): Uint8Array {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.data.length
    ) {
      this.fail('invalid byte range');
    }
    return this.data.slice(start, end);
  }

  expectEnd(what: string): void {
    if (this.pos !== this.limit) {
      this.fail(`${what} has ${this.limit - this.pos} unexpected trailing byte(s)`);
    }
  }
}

function checkedAdd(a: number, b: number, what: string): number {
  if (
    !Number.isSafeInteger(a) ||
    !Number.isSafeInteger(b) ||
    a < 0 ||
    b < 0
  ) {
    throw new BytecodeParseError(`invalid ${what}`);
  }

  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < a) {
    throw new BytecodeParseError(`${what} overflow`);
  }
  return sum;
}

function checkedAddU32(a: number, b: number, what: string): number {
  const sum = checkedAdd(a, b, what);
  if (sum > MAX_U32) {
    throw new BytecodeParseError(`${what} exceeds uint32`);
  }
  return sum;
}

function withSectionId(error: unknown, sectionId: number): never {
  if (error instanceof BytecodeParseError && error.sectionId === undefined) {
    throw new BytecodeParseError(error.message, {
      offset: error.offset,
      sectionId,
    });
  }
  throw error;
}

function readVector<T>(
  cursor: BytecodeCursor,
  what: string,
  readItem: (index: number) => T,
): T[] {
  const count = cursor.varU32(`${what} count`);
  const items: T[] = [];

  for (let index = 0; index < count; index++) {
    items.push(readItem(index));
  }

  return items;
}

function decodeAllInstructions(cursor: BytecodeCursor, codeStart: number): Op[] {
  const ops: Op[] = [];

  while (!cursor.exhausted) {
    const op: Op = {
      offset: cursor.offset - codeStart,
      opcode: cursor.u8('opcode'),
    };

    if (op.opcode === IMMEDIATE_OPCODE) {
      op.operand = cursor.u8('instruction operand');
    }

    ops.push(op);
  }

  return ops;
}

function decodeFunctionInstructions(
  cursor: BytecodeCursor,
  codeStart: number,
): Op[] {
  const ops: Op[] = [];

  while (!cursor.exhausted) {
    const op: Op = {
      offset: cursor.offset - codeStart,
      opcode: cursor.u8('opcode'),
    };

    if (op.opcode === IMMEDIATE_OPCODE) {
      op.operand = cursor.u8('instruction operand');
    }

    ops.push(op);
    if (op.opcode === END_OPCODE) {
      return ops;
    }
  }

  cursor.fail('function body must end with the end opcode');
}

function parseFunctionBody(content: BytecodeCursor): FunctionBody {
  const offset = content.offset;
  const length = content.varU32('function body length');
  const body = content.limited(length, 'function body');
  const contentOffset = body.offset;
  const raw = content.copyRange(offset, body.endOffset);

  let totalLocalCount = 0;
  const locals = readVector(body, 'local declaration group', () => {
    const count = body.varU32('local count');
    const type = body.u8('local type');
    totalLocalCount = checkedAddU32(
      totalLocalCount,
      count,
      'total local declaration count',
    );
    return { count, type };
  });

  const codeStart = body.offset;
  const code = decodeFunctionInstructions(body, codeStart);
  body.expectEnd('function body');

  content.advanceTo(body.endOffset);
  return { offset, length, contentOffset, locals, code, raw };
}

function parseCustomSection(
  content: BytecodeCursor,
  header: SectionHeader,
  raw: Uint8Array,
): CustomSection {
  const nameOffset = content.offset;
  const nameLength = content.varU32('custom section name length');
  const nameBytes = content.take(nameLength, 'custom section name');

  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  } catch {
    content.fail('custom section name is not valid UTF-8', nameOffset);
  }

  const data = content.tail();
  content.expectEnd('custom section');

  return { kind: 'custom', header, nameOffset, name, data, raw };
}

function parseTypeSection(
  content: BytecodeCursor,
  header: SectionHeader,
  raw: Uint8Array,
): TypeSection {
  const types = readVector(content, 'type', () => ({
    params: readVector(content, 'parameter type', () =>
      content.u8('parameter type'),
    ),
    results: readVector(content, 'result type', () =>
      content.u8('result type'),
    ),
  }));

  content.expectEnd('type section');
  return { kind: 'type', header, types, raw };
}

function parseFunctionSection(
  content: BytecodeCursor,
  header: SectionHeader,
  raw: Uint8Array,
): FunctionSection {
  const typeIndices = readVector(content, 'function', () =>
    content.varU32('function type index'),
  );

  content.expectEnd('function section');
  return { kind: 'function', header, typeIndices, raw };
}

function parseCodeSection(
  content: BytecodeCursor,
  header: SectionHeader,
  raw: Uint8Array,
): CodeSection {
  const bodies = readVector(content, 'function body', () =>
    parseFunctionBody(content),
  );

  content.expectEnd('code section');
  return { kind: 'code', header, bodies, raw };
}

function parseUnknownSection(
  content: BytecodeCursor,
  header: SectionHeader,
  raw: Uint8Array,
): UnknownSection {
  const data = content.tail();
  content.expectEnd('unknown section');
  return { kind: 'unknown', header, data, raw };
}

export function parseModule(input: Uint8Array): ParsedModule {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('module bytes must be a Uint8Array');
  }

  const root = BytecodeCursor.root(input);
  const sections: Section[] = [];
  const seenStandardSections = new Set<number>();

  while (!root.exhausted) {
    const sectionOffset = root.offset;
    const id = root.u8('section id');
    const lengthOffset = root.offset;

    let declaredLength: number;
    try {
      declaredLength = root.varU32('section length');
    } catch (error) {
      withSectionId(error, id);
    }

    const contentOffset = root.offset;
    if (declaredLength > root.remaining) {
      throw new BytecodeParseError(
        `section ${id} declares ${declaredLength} bytes but only ${root.remaining} remain`,
        { offset: contentOffset, sectionId: id },
      );
    }

    if (id !== SECTION_ID.CUSTOM && seenStandardSections.has(id)) {
      throw new BytecodeParseError(`duplicate standard section ${id}`, {
        offset: sectionOffset,
        sectionId: id,
      });
    }

    const sectionEnd = checkedAdd(
      contentOffset,
      declaredLength,
      'section end offset',
    );
    const header: SectionHeader = {
      id,
      offset: sectionOffset,
      lengthOffset,
      contentOffset,
      length: declaredLength,
      endOffset: sectionEnd,
    };

    const content = root.limited(declaredLength, 'section content');
    const raw = root.copyRange(sectionOffset, sectionEnd);

    let section: Section;
    switch (id) {
      case SECTION_ID.CUSTOM:
        section = parseCustomSection(content, header, raw);
        break;
      case SECTION_ID.TYPE:
        section = parseTypeSection(content, header, raw);
        break;
      case SECTION_ID.FUNCTION:
        section = parseFunctionSection(content, header, raw);
        break;
      case SECTION_ID.CODE:
        section = parseCodeSection(content, header, raw);
        break;
      default:
        section = parseUnknownSection(content, header, raw);
        break;
    }

    content.expectEnd(`section ${id}`);
    root.advanceTo(sectionEnd);
    sections.push(section);

    if (id !== SECTION_ID.CUSTOM) {
      seenStandardSections.add(id);
    }
  }

  root.expectEnd('module');

  const customSections = sections.filter(
    (section): section is CustomSection => section.kind === 'custom',
  );
  const typeSection = sections.find(
    (section): section is TypeSection => section.kind === 'type',
  );
  const functionSection = sections.find(
    (section): section is FunctionSection => section.kind === 'function',
  );
  const codeSection = sections.find(
    (section): section is CodeSection => section.kind === 'code',
  );
  const unknownSections = sections.filter(
    (section): section is UnknownSection => section.kind === 'unknown',
  );

  return {
    sections,
    customSections,
    typeSection,
    functionSection,
    codeSection,
    unknownSections,
    types: typeSection?.types ?? [],
    functionTypeIndices: functionSection?.typeIndices ?? [],
    bodies: codeSection?.bodies ?? [],
  };
}

export function decode(code: Uint8Array): Op[] {
  const cursor = BytecodeCursor.root(code);
  const ops = decodeAllInstructions(cursor, 0);
  cursor.expectEnd('code');
  return ops;
}

export function boundaries(code: Uint8Array): Set<number> {
  return new Set(decode(code).map((op) => op.offset));
}
