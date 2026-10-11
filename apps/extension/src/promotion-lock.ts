// Serialises the moving of a detected site's titles under the source that now follows it, against the
// handler that records a visit on that site. A visit that lands mid-move would otherwise recreate the
// detected row the move just emptied, stranding its reading history on an id nothing reads any more.
const held = new Map<string, Promise<void>>()

export function holdPromotion<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const previous = held.get(sourceId) ?? Promise.resolve()
    const run = previous.then(work)
    const tail = run.then(
        () => undefined,
        () => undefined
    )
    held.set(sourceId, tail)
    void tail.then(() => {
        if (held.get(sourceId) === tail) held.delete(sourceId)
    })
    return run
}

export async function promotionSettled(sourceId: string): Promise<void> {
    for (let pending = held.get(sourceId); pending; pending = held.get(sourceId)) await pending
}
