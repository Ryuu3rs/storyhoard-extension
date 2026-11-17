// True only in the local testing build (VITE_BUNDLED=1), whose wxt config swaps this module for one that
// says so. The shipped build keeps the literal false, so everything behind it is dropped from the bundle.
export const LAB_BUILD: boolean = false
