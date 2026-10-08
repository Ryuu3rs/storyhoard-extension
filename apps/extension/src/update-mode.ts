// How a user-added site learns about new chapters, in the words the popup shows. "auto": a background
// fetch or a rendered background tab on the update schedule. "on-visit": only from the user's own tab
// when they open the site.
export type UpdateMode = "auto" | "on-visit"

export const UPDATE_MODE_LABEL: Record<UpdateMode, string> = {
    auto: "Auto-updates",
    "on-visit": "Updates when you visit"
}
