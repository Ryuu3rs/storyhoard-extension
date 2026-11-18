const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Tab and Shift+Tab wrap around inside a modal dialog. Focus that has fallen out of it (to the page body,
// when the focused button was replaced) is brought back to its first or last control.
export function keepFocusIn(box: HTMLElement, event: KeyboardEvent): void {
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.getClientRects().length > 0)
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (!box.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
    } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
    }
}
