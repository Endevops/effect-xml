# Effect services refactor — design and plan

Status: in progress. Target: replace the OOP builder/parser classes with
functional interfaces wired through Effect `Layer`s, so nothing is `new`-ed on a
public path and no constructor mutates shared state as a side effect.

## The rule

Every former class becomes one of two things:

- **A configuration service** — something resolved once, shared, and carrying
  authority (options, a registry, a plugin map). It is a `Context.Service` tag
  with a `Layer.effect` implementation, and its methods return `Effect`s.
- **Per-call state** — something a single parse or build owns (the walk, the
  output builder, a pipeline). It is a plain value (or a `Ref`) created _inside_
  an `Effect`, exposed through a narrow interface of functions. It is **not** a
  `Context.Service`, because a new one is needed per document and it has no
  authority to provide.

This is what "stateless config service + per-call state" means in practice: the
shared thing is a service, the per-document thing is a value the service hands
out. Nothing is mutated at construction time; construction is an effect with an
error channel.

## Services

### builder package

| Former class                           | Becomes                                               | Kind     |
| -------------------------------------- | ----------------------------------------------------- | -------- |
| `ValueParserRegistry`                  | `ValueParserRegistry` service (`Ref` over the map)    | config   |
| `BaseOutputBuilderFactory`             | part of the `OutputBuilder` service interface         | config   |
| `CompactBuilderFactory`                | `OutputBuilder` service, `layer(options)`             | config   |
| `BaseValueParser` + built-ins          | `ValueParser` interface, built by plain functions     | value    |
| `ValueParserPipeline`                  | `makePipeline(...)` → interface                       | per-call |
| `BaseOutputBuilder` / `CompactBuilder` | `OutputBuilder` interface, `freshBuilder(...)` effect | per-call |
| `XMLBuilder`                           | `XmlBuilder` service, `layer(options)`, `build` op    | config   |
| `Context` / `SharedContext`            | plain data, no constructor side effects               | value    |

### parser package

| Former class                 | Becomes                                                                    | Kind     |
| ---------------------------- | -------------------------------------------------------------------------- | -------- |
| `XMLParser`                  | `Parser` service, `layer(options)`; `parse`/`parseBytes`/`parseStream` ops | config   |
| `Xml2JsParser`               | per-call walk state + functions, created by an effect                      | per-call |
| `AutoCloseHandler`           | `makeAutoClose(...)` effect → interface                                    | per-call |
| `StopNodeProcessor`          | `makeStopNode(...)` effect → interface                                     | per-call |
| `InputSource` + subclasses   | `InputSource` interface, `make*` effects                                   | per-call |
| `EncodingRegistry`           | `EncodingRegistry` service (`Ref`)                                         | config   |
| readers (`XmlPartReader`, …) | module functions over walk state                                           | function |
| `options-builder`            | `buildOptions` already an effect; stays                                    | function |

## Layers

Options reach a service through its layer:

```ts
const program = Effect.gen(function* () {
  const parser = yield* Parser;
  return yield* parser.parse('<root/>');
});

program.pipe(Effect.provide(Parser.layer({ autoClose: 'html' })));
```

`Parser.layer` rejects a bad configuration in its `E` channel instead of
throwing, which is the whole reason construction is a service and not a
constructor.

## Phases

1. **builder** — value parsers, registry, pipeline, output builder, XML builder;
   migrate `packages/builder/test` and the parser's builder wiring.
2. **parser input layer** — encoding registry, input sources (string/buffer/
   feedable/stream), readers.
3. **parser core** — `Parser` service, walk state, auto-close, stop nodes.
4. **docs** — rewrite the READMEs, `docs/*.md` examples, and the codec package's
   internal use of the builder.

Each phase is one green commit: `vp check` clean and `vp test` green.
