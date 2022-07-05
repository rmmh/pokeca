/**
 * Utils library
 *
 * Miscellaneous utility functions that don't really have a better place.
 *
 * It'll always be a judgment call whether or not a function goes into a
 * "catch-all" library like this, so here are some guidelines:
 *
 * - It must not have any dependencies
 *
 * - It must conceivably have a use in a wide variety of projects, not just
 *   Pokémon (if it's Pokémon-specific, Dex is probably a good place for it)
 *
 * - A lot of Chat functions are kind of iffy, but I'm going to say for now
 *   that if it's English-specific, it should be left out of here.
 */

export type Comparable = number | string | boolean | Comparable[] | { reverse: Comparable };

/**
 * Compares two variables; intended to be used as a smarter comparator.
 * The two variables must be the same type (TypeScript will not check this).
 *
 * - Numbers are sorted low-to-high, use `-val` to reverse
 * - Strings are sorted A to Z case-semi-insensitively, use `{reverse: val}` to reverse
 * - Booleans are sorted true-first (REVERSE of casting to numbers), use `!val` to reverse
 * - Arrays are sorted lexically in the order of their elements
 *
 * In other words: `[num, str]` will be sorted A to Z, `[num, {reverse: str}]` will be sorted Z to A.
 */
export function compare(a: Comparable, b: Comparable): number {
    if (typeof a === 'number') {
        return a - (b as number);
    }
    if (typeof a === 'string') {
        return a.localeCompare(b as string);
    }
    if (typeof a === 'boolean') {
        return (a ? 1 : 2) - (b ? 1 : 2);
    }
    if (Array.isArray(a)) {
        for (let i = 0; i < a.length; i++) {
            const comparison = compare(a[i], (b as Comparable[])[i]);
            if (comparison) return comparison;
        }
        return 0;
    }
    if ('reverse' in a) {
        return compare((b as { reverse: string }).reverse, a.reverse);
    }
    throw new Error(`Passed value ${a} is not comparable`);
}

/**
 * Sorts an array according to the callback's output on its elements.
 *
 * The callback's output is compared according to `PSUtils.compare`
 * (numbers low to high, strings A-Z, booleans true-first, arrays in order).
 */
export function sortBy<T>(array: T[], callback: (a: T) => Comparable): T[];
/**
 * Sorts an array according to `PSUtils.compare`
 * (numbers low to high, strings A-Z, booleans true-first, arrays in order).
 *
 * Note that array.sort() only works on strings, not numbers, so you'll need
 * this to sort numbers.
 */
export function sortBy<T extends Comparable>(array: T[]): T[];
export function sortBy<T>(array: T[], callback?: (a: T) => Comparable) {
    if (!callback) return (array as any[]).sort(compare);
    return array.sort((a, b) => compare(callback(a), callback(b)));
}
