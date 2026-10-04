import { SourceError } from "./errors"
import type { SourceAdapter } from "./types"

export class SourceRegistry {
    readonly #adapters = new Map<string, SourceAdapter>()

    constructor(adapters: readonly SourceAdapter[] = []) {
        for (const adapter of adapters) {
            this.register(adapter)
        }
    }

    register(adapter: SourceAdapter): void {
        if (this.#adapters.has(adapter.manifest.id)) {
            throw new SourceError("invalid-input", `Source is already registered: ${adapter.manifest.id}`)
        }
        this.#adapters.set(adapter.manifest.id, adapter)
    }

    get(sourceId: string): SourceAdapter | undefined {
        return this.#adapters.get(sourceId)
    }

    // Remove a registered source. Returns true if one was removed. Needed so a user-supplied
    // profile can replace a bundled adapter with the same id, and for the dynamic registry.
    unregister(sourceId: string): boolean {
        return this.#adapters.delete(sourceId)
    }

    // Register, replacing any existing adapter with the same id instead of throwing.
    upsert(adapter: SourceAdapter): void {
        this.#adapters.set(adapter.manifest.id, adapter)
    }

    match(url: URL): SourceAdapter | undefined {
        return this.list().find(adapter => adapter.match(url) !== "none")
    }

    list(): readonly SourceAdapter[] {
        return [...this.#adapters.values()]
    }
}
