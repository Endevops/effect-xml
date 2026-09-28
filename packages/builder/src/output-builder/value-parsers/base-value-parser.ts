import { Effect } from 'effect';

import type { BuilderError } from '../../errors.ts';
import type { Context, SharedContext, ValueParser } from '../value-parser.ts';

import { BuilderError as BuilderErrorCtor } from '../../errors.ts';

/**
 * @description The base class every value parser should extend. It handles the `IS_FINAL` flag and the `init`/`reset` lifecycle the pipeline drives, so a subclass
 * only has to implement `parse`.
 *
 * @example
 *   ```typescript
 *   class MyParser extends BaseValueParser {
 *     constructor(options?: object) {
 *       super(false);
 *       this.options = options ?? {};
 *     }
 *     parse(val: unknown): unknown {
 *       const result = transform(val);
 *       return this.IS_FINAL ? new FinalValue(result) : result;
 *     }
 *   }
 *   ```;
 */
export default class BaseValueParser implements ValueParser {
  /**
   * @description When true, `parse` is expected to wrap its result in a `FinalValue` to end the chain. The pipeline does not enforce this — it only unwraps one if
   * it sees it — so a parser that ignores the flag still works, it just does not stop the chain.
   */
  IS_FINAL: boolean;
  /**
   * @description The document's shared store, injected by the pipeline through {@link BaseValueParser.init}. `undefined` until then, so a parser must tolerate
   * being run outside a pipeline.
   */
  ctx: SharedContext | undefined;

  /**
   * @description Create a parser.
   *
   * @param IS_FINAL - Whether this parser ends the chain when it produces a value. Defaults to false.
   */
  constructor(IS_FINAL = false) {
    this.IS_FINAL = IS_FINAL;
  }

  /**
   * @description Receive the document's shared store. Called by the pipeline, once per document, after construction. Parsers needing the XML version or the
   * DOCTYPE entities read them from `ctx` lazily inside `parse` rather than here: by the time the first value is parsed, both are populated. Override
   * only to pre-read something at init time.
   *
   * @param ctx - The document's store.
   */
  init(ctx: SharedContext): void {
    this.ctx = ctx;
  }

  /**
   * @description Clear any state held across values. Called between document parses. Stateless parsers need not override it.
   */
  reset(): void {
    // Nothing to clear.
  }

  /**
   * @description Transform one value.
   *
   * @param val - The value.
   * @param runtimeContext - Where the value came from.
   *
   * @returns An effect producing the transformed value. Fails with {@link BuilderError} and the `NotImplemented` reason, always — a subclass must
   *   override this. The value and the context are unused, which is why the parameters are referenced rather than dropped.
   */
  parse(val: unknown, runtimeContext?: Context): Effect.Effect<unknown, BuilderError> {
    void val;
    void runtimeContext;
    return Effect.fail(
      new BuilderErrorCtor({ reason: { _tag: 'NotImplemented', member: 'parse' }, message: 'You must implement parse() in a value parser.' })
    );
  }
}
