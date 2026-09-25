# 03 — Value Parsers

Value parsers transform text values extracted from XML — tag content, CDATA, and attribute values. They run left-to-right so each parser receives the output of the previous one.

Value parsers are configured on the **output builder** (`@nodable/base-output-builder` and its subclasses), not on `XMLParser` directly.

CDATA, comments, stopnodes are not processed by any value parser.

---

## Configuring the Pipeline

```javascript
import { CompactBuilderFactory } from '@nodable/compact-builder';

const builder = new CompactBuilderFactory({
  tags: { valueParsers: ['ws', 'entity', 'boolean', 'number'] }, // default
  attributes: { valueParsers: ['entity', 'number', 'boolean'] }, // default
});
const parser = new XMLParser({ OutputBuilder: builder });
```

Each entry is either a **string name** (built-in or registered custom) or a **parser instance** with a `parse(val, context?)` method.

To disable all transformation:

```javascript
const builder = new CompactBuilderFactory({ tags: { valueParsers: [] }, attributes: { valueParsers: [] } });
// All values come out as raw strings
```

---

## Built-in Parsers

### `'entity'`

Expands XML entity references (`&lt;`, `&gt;`, `&amp;`, `&apos;`, `&quot;`), optional HTML entities, DOCTYPE-declared entities, and custom entities added via `addEntity()`.

Which sources are active is controlled by `EntitiesValueParser` from `@nodable/base-output-builder`:

```javascript
import { XML, COMMON_HTML, ENTITY_ACTION } from '@nodable/entities';
import { EntitiesValueParser } from '@nodable/base-output-builder';
import { CompactBuilderFactory } from '@nodable/compact-builder';

const evp = new EntitiesValueParser({
  namedEntities: { ...XML },
  numericAllowed: true,
  //limit: {},
  onInputEntity: (name, value) => (isUnsafe(value, [VALID_CONTEXTS.XML]) ? ENTITY_ACTION.BLOCK : ENTITY_ACTION.ALLOW),
});
const builder = new CompactBuilderFactory();
builder.registerValueParser('entity', evp);
```

Check '@nodable/entities' for more details on configuration.

DOCTYPE entity collection is controlled separately by `doctypeOptions.enabled` on `XMLParser` (it happens at read time, before value parsing).

Remove `'entity'` from the chain to leave all references unexpanded:

```javascript
const builder = new CompactBuilderFactory({ tags: { valueParsers: ['boolean', 'number'] } });
// &lt; stays as the literal string "&lt;"
```

### `'boolean'`

Converts `"true"` and `"false"` (case-insensitive) to JavaScript `true`/`false`. All other values pass through unchanged. You can pass list of true and false values.

```javascript
import { BooleanParser } from '@nodable/base-output-builder';

const builder = new CompactBuilderFactory();
builder.registerValueParser('boolean', new BooleanParser({ trueList: ['yes', 'y'], falseList: ['no', 'n'] }));
// "yes" becomes true, "no" becomes false, "true" and "false" stay as strings
```

This final the value on successful match and doesn't process further value parsers. However, you can override this setting.

### `'number'`

Converts numeric strings to JS numbers using the [`strnum`](https://www.npmjs.com/package/strnum) library.

| Option         | Default      | Description                                                                |
| -------------- | ------------ | -------------------------------------------------------------------------- |
| `hex`          | `true`       | Parse `0x…` hex literals                                                   |
| `leadingZeros` | `true`       | Parse `007` as `7`                                                         |
| `eNotation`    | `true`       | Parse `1.5e3` as `1500`                                                    |
| `infinity`     | `"original"` | What to do with overflow: `"original"`, `"infinity"`, `"string"`, `"null"` |

Check `strnum` package for more details. To customise, import and register directly:

```javascript
import { NumberValueParser } from '@nodable/base-output-builder';

const builder = new CompactBuilderFactory();
builder.registerValueParser('number', new NumberValueParser({ leadingZeros: false }));
// "007" stays as "007"; 9.99 converts normally
```

This final the value on successful match and doesn't process further value parsers. However, you can override this setting.

### `'trim'`

Strips leading/trailing whitespace. Not in the default chain — add explicitly. Place it **before** `'boolean'` and `'number'` so whitespace is removed before type coercion.

```javascript
tags: {
  valueParsers: ['entity', 'trim', 'boolean', 'number'];
}
```

### `'WSNormalizer'`

Collapses runs of whitespace (spaces, tabs, newlines) to a single space and trims both ends.
**Replaces `'trim'`** in the default chain.

Normalization is automatically skipped when:

- The value is not a string
- The element is an attribute
- Under `xml:space="preserve"` scope
- The tag path matches a user-supplied exclusion list

```javascript
import { WSNormalizer } from '@nodable/base-output-builder';

const ws = new WSNormalizer({
  exclude: ['..pre', '..code', '..script'], // leave whitespace untouched in these
});
factory.registerValueParser('ws', ws);
```

---

## Custom Value Parsers

Any object with a `parse(val, context?)` and `reset()` method works as a value parser:

```javascript
class UpperCaseParser extends BaseValueParser {
  constructor(options, isfinal) {
    super(isfinal);
  }
  parse(val) {
    return typeof val === 'string' ? val.toUpperCase() : val;
  }
}

const builder = new CompactBuilderFactory({ tags: { valueParsers: ['entity', new UpperCaseParser(), 'boolean', 'number'] } });
```

Register by name to reference in multiple chains:

```javascript
factory.registerValueParser('upper', new UpperCaseParser());
// now usable by name in any valueParsers array
```

---

## The Context Object

Each parser receives a `context` as its second argument:

```javascript
{
  elementName:  string,             // tag or attribute name
  matcher:      ReadOnlyMatcher,    // inspect path, position
  isLeafNode:   boolean | null,
  isAttribute:   boolean,
}
```

Use `ElementType` from `@nodable/base-output-builder` for the constants:

```javascript
import { ElementType } from '@nodable/base-output-builder';

class TagOnlyParser {
  parse(val, context) {
    if (context?.elementType === ElementType.ATTRIBUTE) return val;
    // only process tag values
    return doSomething(val);
  }
}
```

---

## Order Matters

- Put `'entity'` first — downstream parsers see clean characters, not `&amp;` etc.
- Put `'trim'` before `'boolean'` and `'number'` so `"  true  "` → `"true"` first
- Put `'number'` after `'boolean'` — once a value is `true`, number sees a non-string and passes through

Recommended order: `[`ws`, 'entity', 'boolean', 'number']` for tags. `[`ws`, 'entity', 'boolean', 'number']` for attributes.

---

## Separate Pipelines for Tags vs Attributes

```javascript
const builder = new CompactBuilderFactory({
  tags: { valueParsers: ['entity', 'trim', 'boolean', 'number'] },
  attributes: { valueParsers: ['entity', 'number'] }, // no booleans in attrs
});
```

---

➡ Next: [04 — Stop Nodes & Skip Tags](./04-stop-nodes.md)
