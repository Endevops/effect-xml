export type BufferSourceOptions = {
  /**
   * @description Enable automatic flushing.
   *
   * @default `true`
   */
  autoFlush?: boolean;
  /**
   * @description Flush after this many processed bytes.
   *
   * @default `1024`
   */
  flushThreshold?: number;
};
