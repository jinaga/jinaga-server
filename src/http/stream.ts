export interface Stream<T> {
    next(handler: (data: T) => void): Stream<T>;
    done(handler: () => void): Stream<T>;
    close(): void;
}