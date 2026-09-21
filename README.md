# Bytecode verifier core

TypeScript library for module decoding and validation.

## Module layout

A module is a sequence of sections. Each section starts with:

- `id: byte`
- `content_size: varuint32`
- `content_size` payload bytes

Known standard sections:

- `1`: function types
- `2`: function type indices
- `3`: function bodies
- `0`: custom section: `name_length: varuint32`, name bytes, then arbitrary data

Every declared section and function body is parsed through a bounded cursor.
Known standard sections must consume their complete payload. Custom sections
may retain bytes after their name as opaque data. Unknown section ids are
stored byte-for-byte without payload validation. Section and body lengths use
canonical u32 LEB128; overflowing lengths, end offsets, vectors, and nested
counts are rejected.

Use `parseModule(bytes)` to parse modules. Parse failures throw
`BytecodeParseError` with the failing section's offset.

Run `npm install`, then `npm test` and `npm run build`.
