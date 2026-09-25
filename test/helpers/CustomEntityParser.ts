import { EntityDecoder } from '@nodable/entities';

export default class EntityParser extends EntityDecoder {
  #seen = false;
  constructor(options) {
    super(options);
  }

  init(ctx) {
    // By ValueParserPipeline
    this.ctx = ctx;
  }

  #ensureDecoder() {
    if (!this.#seen) {
      const version = this.ctx?.get('xmlVersion');
      const entities = this.ctx?.get('inputEntities');
      if (version) this.setXmlVersion(version);
      if (entities) this.addInputEntities(entities);
      this.#seen = true;
    }
  }

  reset() {
    super.reset();
    this.#seen = false;
  }

  parse(val) {
    if (typeof val === 'string') {
      this.#ensureDecoder();
      val = this.decode(val);
    }

    return val;
  }
}
