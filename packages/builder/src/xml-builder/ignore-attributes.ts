import type { IgnoreAttributesPredicate } from './options.ts';

/**
 * @description Normalise the `ignoreAttributes` option into a single predicate. The option has four forms — `true` drops every attribute, `false` keeps them all,
 * an array of names and patterns drops the matches, and a function decides per attribute — and the hot path wants one call rather than a branch on
 * which form it is. Resolving it once in the constructor also means the array form is walked per attribute instead of re-classified per attribute.
 *
 * @param ignoreAttributes - The configured value.
 *
 * @returns The predicate to call per attribute.
 */
const getIgnoreAttributesFn = (
  ignoreAttributes: IgnoreAttributesPredicate | Array<string | RegExp> | boolean | undefined
): IgnoreAttributesPredicate => {
  if (typeof ignoreAttributes === 'function') {
    return ignoreAttributes;
  }
  if (Array.isArray(ignoreAttributes)) {
    return (attrName: string): boolean => {
      for (const pattern of ignoreAttributes) {
        if (typeof pattern === 'string' && attrName === pattern) {
          return true;
        }
        if (pattern instanceof RegExp && pattern.test(attrName)) {
          return true;
        }
      }
      return false;
    };
  }
  return () => false;
};

export default getIgnoreAttributesFn;
