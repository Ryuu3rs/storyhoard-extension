// Single source of truth for the consent-card copy and the in-app privacy summary shown in
// Settings -> Privacy & Community. Kept as data (not inline JSX) so the exact same wording is
// reused by the first-run card, the Settings re-read, and the hosted copy. This is a plain
// summary; the full policy that governs the extension, the website, and the mobile app lives at
// POLICY_URL. CONSENT_VERSION (in community.ts) must stay lockstep with the community server and
// only moves when the community channel collects something new.

// The short bullet list shown on the consent card and at the top of the Settings section.
export const DATA_COLLECTED: readonly string[] = [
    "A random install id, your browser name and extension version (no name, email, or IP)",
    "A username you choose",
    "Which chapters you read: title, source site, genres, date, and chapter number",
    "The ratings and votes you give titles"
]

export const DATA_NOT_COLLECTED: readonly string[] = [
    "The pages and chapters you read, or anything you download",
    "Your browsing history outside StoryHoard",
    "Your name, email, or IP-based location (the community channel has no account; creating a " +
        "weeb.ltd account is separate and asks for an email)",
    "Any payment information"
]

// One-line summary for the consent card body.
export const CONSENT_SUMMARY =
    "StoryHoard can send anonymous usage and a username you choose to the StoryHoard community server to " +
    "power install counts, leaderboards, and recommendations. We never sell your data, and " +
    "you can turn this off anytime in Settings."

// What the "Disable" choice means, shown under that button so declining is a fully informed,
// low-pressure choice (keeps consent freely given).
export const DECLINE_EXPLAINER =
    "StoryHoard keeps working exactly the same - you just won't see community features like " +
    "leaderboards and recommendations. You can turn it on anytime in Settings."

// The full policy is hosted; this is the in-app summary. POLICY_VERSION stamps the hosted copy
// and is informational (it does not drive the consent re-prompt; CONSENT_VERSION does).
export const POLICY_VERSION = 3
export const POLICY_URL = "https://weeb.ltd/legal/privacy"
export const TERMS_URL = "https://weeb.ltd/legal/terms"
export const POLICY_CONTACT = "privacy@weeb.ltd"

export type PolicySection = { heading: string; body: string[] }

export const PRIVACY_POLICY: readonly PolicySection[] = [
    {
        heading: "StoryHoard Privacy & Data Policy",
        body: [
            "StoryHoard is a browser extension for reading and tracking manga. Reading, tracking, " +
                "downloads, and history stay in your browser and need no account, sign-in, or " +
                "server connection.",
            "This is a summary. The full policy that governs the extension, the weeb.ltd website, " +
                "and the mobile app is at weeb.ltd/legal/privacy."
        ]
    },
    {
        heading: "Usage analytics (on by default)",
        body: [
            "To help improve the app we collect anonymous usage: which screens and features you " +
                "use, whether chapters captured successfully, your app version and browser. This " +
                "is on by default on a legitimate-interest basis.",
            "It never includes your titles, what you read, genres, notes, ratings, your account, " +
                "or any content. You can turn it off any time in Settings, and turning it off " +
                "stops it immediately. If you have a weeb.ltd account, the opt-out there switches " +
                "it off everywhere too. On Firefox you can also turn this off when you install the " +
                "extension or later in the browser's add-on permissions, and the extension honours " +
                "that choice."
        ]
    },
    {
        heading: "Community features (optional, off by default)",
        body: [
            "If you accept the consent card, the extension sends to our community server:",
            ...DATA_COLLECTED.map(d => `- ${d}`),
            "This powers install counts, leaderboards, the community vote, and 'readers also " + "read' suggestions.",
            "Whether or not community features are on, the extension checks our server for " +
                "service announcements when it opens; that request sends only your browser name " +
                "and extension version, with no identifier."
        ]
    },
    {
        heading: "Account sync (optional, off until you link an account)",
        body: [
            "Syncing is separate from community features and off until you link an account by " +
                "pasting a device code from weeb.ltd. When enabled, StoryHoard uploads your library so " +
                "it can be restored on your other devices. For each title that includes:",
            "- The title, its source site, source URL, cover image URL, and genres",
            "- Your reading progress, ratings, and reading status",
            "- Your private notes, your categories/tags, and whether you flagged it NSFW",
            "- Your per-title reader preferences (direction, fit, page width)",
            "- The name you give the device",
            "If community features are also on, linking ties your anonymous community id to your " +
                "account so the account owns that history; unlinking or deleting the account " +
                "removes the tie.",
            "Your account identity (your email and sign-in provider) is collected by weeb.ltd " +
                "when you create the account, not by the extension, and is covered by the full " +
                "policy. StoryHoard never uploads the pages or chapter content you read."
        ]
    },
    {
        heading: "What never leaves your device unless you link an account",
        body: DATA_NOT_COLLECTED.map(d => `- ${d}`)
    },
    {
        heading: "We never sell your data",
        body: [
            "We do not sell, rent, or share your data with advertisers or any third party. It " +
                "is used only to run the features above."
        ]
    },
    {
        heading: "Your choices and rights",
        body: [
            "- Community features are off until you tap Accept.",
            "- Turning community features off stops sending immediately; 'Delete my community " +
                "data' removes what the server already holds.",
            "- You can unlink account sync at any time in Settings to stop syncing. You can " +
                "export or delete your account library, and close the account, from weeb.ltd.",
            "- In the EU/UK you have the right to access, correct, or erase your data and to " +
                "withdraw consent - the controls here and on weeb.ltd let you do this directly."
        ]
    },
    {
        heading: "Where your data is stored",
        body: [
            "Community and account data is stored on our own servers in the European Union. It " +
                "is not shared with other services."
        ]
    },
    {
        heading: "Age, contact, and changes",
        body: [
            "Accounts and community features are for people aged 13 or over, or the age of " +
                "digital consent where you live if that is higher. Creating an account or " +
                "turning on community features confirms you meet it.",
            `Questions or a data request: ${POLICY_CONTACT}.`,
            "If we materially change this policy, the app will ask you to review and accept the " +
                "new version before continuing to send data."
        ]
    }
]
