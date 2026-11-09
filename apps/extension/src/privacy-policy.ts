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
export const POLICY_VERSION = 4
export const POLICY_URL = "https://weeb.ltd/legal/privacy"
export const TERMS_URL = "https://weeb.ltd/legal/terms"
export const POLICY_CONTACT = "privacy@weeb.ltd"

export type PolicySection = { heading: string; body: string[] }

export const PRIVACY_POLICY: readonly PolicySection[] = [
    {
        heading: "StoryHoard Privacy & Data Policy",
        body: [
            "StoryHoard is a browser extension for tracking manga and comics. Your library, " +
                "reading progress, downloads and history live in your browser and need no account " +
                "or sign-in.",
            "This is a summary. The full policy that governs the extension, the weeb.ltd website, " +
                "and the mobile app is at weeb.ltd/legal/privacy."
        ]
    },
    {
        heading: "Requests to the sites you track",
        body: [
            "To find new chapters, StoryHoard contacts the sites you track straight from your " +
                "browser, the same as visiting them yourself. Those sites see your IP address. For " +
                "some sites the check opens the site in a hidden tab, which uses your own cookies " +
                "for that site. Covers and any pages you download come from those sites or their " +
                "image hosts."
        ]
    },
    {
        heading: "Title lookups",
        body: [
            "To fill in covers, genres and publishing status, StoryHoard looks up the titles in " +
                "your library on AniList. A lookup sends the title only. It does not send your " +
                "account, your progress or anything else about you, beyond the IP address any " +
                "request carries. Firefox lists this at install as website content.",
            "When you search for a title, the words you type go to weeb.ltd's title search, and to " +
                "AniList if weeb.ltd can't answer, to find the title. The search is not linked to " +
                "you or your account. Finding where to read it then happens in your browser, on " +
                "the sites you use."
        ]
    },
    {
        heading: "Detect on all sites (optional, off by default)",
        body: [
            "If you turn this on in Settings, your browser lets StoryHoard look at any https page " +
                "you open, so the panel can appear on reader sites you have not allowed one by one.",
            "On each https page you open it reads the page title, links and image sizes on your " +
                "device to decide whether the page is a reader, looking again for a few seconds " +
                "while the page finishes drawing. Nothing it reads is sent anywhere or kept.",
            "A site only joins your library when you press Track, or when you have turned on " +
                "'Follow recognised sites automatically'. From then on it is a tracked site like any " +
                "other, as described above.",
            "Turn it off at any time in Settings or in your browser's extension permissions."
        ]
    },
    {
        heading: "Usage analytics",
        body: [
            "To help improve the app we collect anonymous usage: which screens and features you " +
                "use, whether chapters captured successfully, your app version and browser. This " +
                "is on a legitimate-interest basis. On Chrome it starts after you make a choice on " +
                "the first-run screen. On Firefox it runs only if you allow it when you install the " +
                "extension or later in the browser's add-on permissions.",
            "It never includes your titles, what you read, genres, notes, ratings, or any content. " +
                "If you link a weeb.ltd account, the request carries your device link so our server " +
                "can honour that account's analytics opt-out and age settings. You can turn " +
                "analytics off any time in Settings, and it stops immediately."
        ]
    },
    {
        heading: "Community features (optional, off by default)",
        body: [
            "If you accept the consent card, the extension sends to our community server:",
            ...DATA_COLLECTED.map(d => `- ${d}`),
            "This powers install counts, leaderboards, the community vote, and 'readers also " + "read' suggestions.",
            "Whether or not community features are on, the extension fetches public community " +
                "lists (such as trending titles) and service announcements. Those requests carry " +
                "no identifier: at most your browser name and extension version."
        ]
    },
    {
        heading: "Account sync (optional, off until you link an account)",
        body: [
            "Syncing is separate from community features and off until you link an account by " +
                "pasting a device code from weeb.ltd. When linked, StoryHoard uploads your library so it can be restored on your other " +
                "devices. For each title that includes:",
            "- The title, its source site, source URL, cover image URL, genres and AniList id",
            "- Your reading progress, when you last read it, your ratings and reading status",
            "- Your private notes, your categories/tags, and whether you flagged it NSFW",
            "- Your per-title reader preferences",
            "- Titles you remove, so they are removed on your other devices too",
            "If community features are also on, linking ties your anonymous community id to your " +
                "account so the account owns that history; unlinking or deleting the account " +
                "removes the tie.",
            "Your account identity (your email and sign-in provider) is collected by weeb.ltd " +
                "when you create the account, not by the extension, and is covered by the full " +
                "policy. StoryHoard never uploads the pages or chapter content you read.",
            "On weeb.ltd pages the extension tells the page its version and whether it is linked, " +
                "so the site can show the right buttons."
        ]
    },
    {
        heading: "Backups and list sync you set up yourself",
        body: [
            "- GitHub backup: if you add a GitHub token, StoryHoard saves your full library export " +
                "(titles, chapter links, reading history, bookmarks and added sites) to a secret " +
                "gist on your GitHub account. A secret gist is hidden from search, but anyone with " +
                "its link can open it.",
            "- AniList list sync: if you add an AniList token, StoryHoard updates your AniList " +
                "list with your progress and status, and adds or removes entries to match.",
            "Both are off until you add a token, and stop when you remove it."
        ]
    },
    {
        heading: "Other requests",
        body: [
            "StoryHoard checks GitHub for new versions and weeb.ltd for the list of official " +
                "sites. Those requests carry only what any web request does: your IP address and " +
                "the extension version."
        ]
    },
    {
        heading: "What never leaves your device unless you turn on a feature above",
        body: DATA_NOT_COLLECTED.map(d => `- ${d}`)
    },
    {
        heading: "We never sell your data",
        body: [
            "We do not sell or rent your data, and we do not share it with advertisers. Outside " +
                "our own servers, the only services that see anything are the ones named above " +
                "(the sites you track, AniList and GitHub), and only for those features."
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
            "- Tokens you give StoryHoard (weeb.ltd link, AniList, GitHub) are kept in the " +
                "extension's own browser storage, which websites and other extensions cannot read.",
            "- In the EU/UK you have the right to access, correct, or erase your data and to " +
                "withdraw consent - the controls here and on weeb.ltd let you do this directly."
        ]
    },
    {
        heading: "Where your data is stored",
        body: [
            "Community, account and analytics data is stored on our own servers in the " +
                "European Union. It is not shared with other services."
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
