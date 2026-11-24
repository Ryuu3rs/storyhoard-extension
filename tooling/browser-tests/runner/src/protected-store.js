// The extension keeps its tokens and user-only stores in its own IndexedDB database, not storage.local
// (src/protected-store.ts). Tests seed them here. Self-contained: it runs inside the extension's worker
// or page, passed as a function to Playwright or as source text to WebDriver.
export async function getProtected(key) {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("storyhoard-protected")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    try {
        if (!db.objectStoreNames.contains("kv")) return undefined
        return await new Promise((resolve, reject) => {
            const request = db.transaction("kv", "readonly").objectStore("kv").get(key)
            request.onsuccess = () => resolve(request.result?.value)
            request.onerror = () => reject(request.error)
        })
    } finally {
        db.close()
    }
}

export async function putProtected(entries) {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("storyhoard-protected")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction("kv", "readwrite")
            for (const [key, value] of Object.entries(entries)) tx.objectStore("kv").put({ key, value })
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    } finally {
        db.close()
    }
}
