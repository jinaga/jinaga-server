/**
 * A bookmark names the position of a feed page in a store's own order.
 *
 * The Postgres store spells it as the fact ids of the last tuple on the
 * page, joined with dots, and pages a feed by comparing those positions
 * element by element (see `generateSqlQuery` in
 * `src/postgres/specification-sql.ts`, which orders by the same array).
 *
 * This module is the one place that spelling is read, so a reader that
 * needs to compare two bookmarks gets the order the store pages by rather
 * than a second guess at it.
 */

/**
 * Read a bookmark's positions. An empty bookmark is the start of the feed,
 * so it yields no positions. A bookmark that is not a dotted list of
 * integers has no position at all, and yields null.
 */
export function parseBookmarkPositions(bookmark: string): number[] | null {
    if (!bookmark) {
        return [];
    }
    const positions = bookmark.split(".").map(part => parseInt(part));
    return positions.some(position => isNaN(position)) ? null : positions;
}

/**
 * Order two bookmarks the way the store pages them: element by element,
 * and a prefix before the bookmark that extends it. Negative when the
 * left bookmark comes first, positive when the right one does, zero when
 * they name the same position.
 */
export function compareBookmarkPositions(left: number[], right: number[]): number {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index++) {
        if (left[index] !== right[index]) {
            return left[index] < right[index] ? -1 : 1;
        }
    }
    return left.length - right.length;
}
