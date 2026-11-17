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
    "The content of the pages and chapters you read, or anything you download",
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
export const POLICY_VERSION = 5
export const POLICY_URL = "https://weeb.ltd/legal/privacy"
export const TERMS_URL = "https://weeb.ltd/legal/terms"
export const POLICY_CONTACT = "privacy@weeb.ltd"

// Everything the app and the policy say about usage analytics. Keep it to this line.
export const USAGE_ANALYTICS_LINE = "We collect anonymous usage stats. Turn them on or off in Settings."

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
                "image hosts. How often StoryHoard checks the sites you track is your own setting, " +
                "under Update schedule in Settings.",
            "Other update checks send no cookies. If you turn on 'Use my browser session' for a site " +
                "(off for every site until you do), its update checks also send your cookies for that " +
                "site, and only to that site, so a site that needs you signed in can still be checked."
        ]
    },
    {
        heading: "Title lookups",
        body: [
            "To fill in covers, genres and publishing status, StoryHoard looks up the titles in " +
                "your library on AniList. A lookup sends the title. For Discover, StoryHoard also " +
                "sends the AniList ids of titles in your library to AniList, to find recommendations " +
                "and sequels. Lookups do not send your " +
                "account, your progress or anything else about you, beyond the IP address any " +
                "request carries, and they send no cookies. Firefox lists this at install as website " +
                "content.",
            "When no other lookup finds a cover, StoryHoard asks weeb.ltd for one, sending the " +
                "title and its AniList id if known. weeb.ltd may look the title up on other catalogs " +
                "(MangaDex, Jikan, MangaUpdates) from its own server; your browser only talks to " +
                "weeb.ltd. The lookup is not linked " +
                "to you or your account.",
            "When you search for a title, the words you type go to weeb.ltd's title search, and to " +
                "AniList if weeb.ltd can't answer, to find the title. The search is not linked to " +
                "you or your account. Finding where to read it then happens in your browser, on " +
                "the sites you use.",
            "When you pick a title from search, the 'Where to read' list asks weeb.ltd for official " +
                "places to read or buy it, sending that title's catalog id (its weeb.ltd or AniList " +
                "id). This is not linked to you or your account.",
            "Discover also loads public lists from weeb.ltd, such as trending titles, this season's " +
                "titles and staff and community picks. These requests send no cookies and nothing about " +
                "you or your library: the app hides titles you already have on your own device.",
            "'Search the web' on a title's page hands that title's name (and a word like 'manhwa') to " +
                "your browser's own search engine, in a new tab, only when you click it. The first click " +
                "asks your browser for permission to use its search. StoryHoard does not choose the " +
                "search engine or see the results."
        ]
    },
    {
        heading: "Detect on all sites (optional, off by default)",
        body: [
            "If you turn this on in Settings, your browser lets StoryHoard look at any https page " +
                "you open, so the panel can appear on reader sites you have not allowed one by one.",
            "On each https page you open it reads the page title, links and image sizes on your " +
                "device to decide whether the page is a reader, looking again for a few seconds " +
                "while the page finishes drawing. For a page it decides is not a reader, nothing it " +
                "read is sent anywhere or kept.",
            "When a page is a reader, the panel appears and, while 'Auto-add manga' is on (it is " +
                "on by default), the title and the chapter you are reading are saved to your library " +
                "like any other title you read: the title, the page address and your progress. They " +
                "stay on your device, and are uploaded with your library only if you link an account " +
                "(see Account sync below). Turn 'Auto-add manga' off to save titles only when you " +
                "press Track.",
            "The site itself is only followed, so its titles get update checks, when you press " +
                "Track or have turned on 'Follow recognised sites automatically'. From then on it is " +
                "a tracked site like any other, as described above.",
            "Turn it off at any time in Settings or in your browser's extension permissions."
        ]
    },
    {
        heading: "Usage analytics",
        body: [USAGE_ANALYTICS_LINE]
    },
    {
        heading: "Community features (optional, off by default)",
        body: [
            "If you accept the consent card, the extension sends to our community server:",
            ...DATA_COLLECTED.map(d => `- ${d}`),
            "This powers install counts, leaderboards, the community vote, and 'readers also " + "read' suggestions.",
            "On Firefox, turning community features on also asks Firefox for permission to send " +
                "this data (browsing activity, technical data and the username). Nothing is sent " +
                "while Firefox does not allow it.",
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
            "- Its publishing status and the latest chapter number StoryHoard has found",
            "- Your reading progress, when you last read it, your ratings, reading status and when " +
                "you last changed it",
            "- Your private notes, your categories/tags, and whether you flagged it NSFW, put it on " +
                "hold or track it by hand",
            "- Your per-title reader preferences",
            "- Titles you remove, so they are removed on your other devices too",
            "While linked, the app also asks weeb.ltd for your Scales balance (sending the device " +
                "link) to show it in the footer.",
            "On Firefox, linking an account asks Firefox for permission to send browsing activity, " +
                "and nothing is synced until it allows it.",
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
                "(titles, chapter links, reading history, bookmarks, added sites, and the names and " +
                "order you gave your sources) to a secret " +
                "gist on your GitHub account. A secret gist is hidden from search, but anyone with " +
                "its link can open it.",
            "- AniList list sync: if you add an AniList token, StoryHoard updates your AniList " +
                "list with your progress and status, and adds or removes entries to match.",
            "Both are off until you add a token, and stop when you remove it. On Firefox, both also " +
                "ask Firefox for permission to send browsing activity, and send nothing until it " +
                "allows it."
        ]
    },
    {
        heading: "Other requests",
        body: [
            "StoryHoard checks weeb.ltd for the list of official sites, and each time you open the " +
                "app it sends an empty request to weeb.ltd to see whether the site is reachable. A " +
                "copy installed from GitHub on Chrome, rather than from a browser's add-on store, " +
                "also checks GitHub for new versions. Those requests send no cookies and carry only " +
                "what any web request does: your IP address and, at most, the extension version.",
            "Cover images in search results and suggestions load from wherever the catalog keeps " +
                "them (for example AniList's or MyAnimeList's image servers). Loading an image tells " +
                "that server your IP address and that the image was requested, nothing else."
        ]
    },
    {
        heading: "Blocked ad redirects",
        body: [
            "StoryHoard carries a fixed list of known pop-under and redirect ad domains, and your " +
                "browser blocks pages, frames, scripts and requests to them on every site. This stops " +
                "a reader site from bouncing you to those ads. The list is part of the extension; " +
                "nothing about the pages you visit is recorded or sent anywhere."
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
                "(the sites you track, AniList, the image servers covers load from, and GitHub), " +
                "and only for those features."
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
            "If a change to this policy means the app sends something new, it tells you before " +
                "sending it: community features ask for your consent again."
        ]
    }
]
