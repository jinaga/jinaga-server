function safeFlatten<U>(results: U[][]) {
  const flat = results.reduce((a, b) =>
    (!a || a.length === 0) ? b :
    (!b || b.length === 0) ? a :
      a.concat(b));
  return flat ? flat : [];
}

export function flatten<T, U>(collection: T[], selector: (element: T) => U[]) {
    if (collection.length === 0) {
        return [];
    }
    else {
        return safeFlatten(collection.map(selector));
    }
}

export function distinct<T>(value: T, index: number, self: T[]) { 
    return self.indexOf(value) === index;
}