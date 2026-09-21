# Bytecode verifier core

TypeScript library for module decoding and validation.

Run `npm install`, then `npm test` and `npm run build`.

## Module parsing

`parseModule` decodes a sequence of `id + LEB128 length + payload` sections.
Each section and function body is decoded through a restricted cursor, so a
declared length can never read into the next section or past the enclosing
module. Unknown sections are retained verbatim without interpreting their
payload.

```ts
import { parseModule } from './dist/index.js';

const module = parseModule(bytes);

for (const section of module.sections) {
  console.log(section.kind, section.header);
}
```
