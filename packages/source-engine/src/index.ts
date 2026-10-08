// ARCHITECTURE TRACK A (experimental) - user-supplied declarative source engine.
//
// This package is the P0 of the neutral-engine re-architecture. It is NOT wired into the
// shipped extension and changes no runtime behaviour on main; it exists so the direction can
// be evaluated in isolation on the arch/source-engine branch. See the neutral-engine plan and
// council review in the StoryHoard ecosystem docs (ECO_NEUTRAL_SOURCE_ENGINE_PLAN.md).

// Marks every artifact of this track so a build/log is never confused with the release line.
export const ARCH_TRACK = "A" as const

export { createAdapterFromProfile } from "./create-adapter-from-profile"
export {
    parseProfile,
    profileSchema,
    PROFILE_FORMAT,
    PROFILE_FORMAT_2,
    PROFILE_FORMATS,
    NUMBER_SOURCES,
    regexComplexityIssue,
    type NumberSource,
    type SiteProfile,
    type ProfileParseResult
} from "./profile-schema"
export { interpolate, InterpolationError, type InterpolationScope } from "./interpolate"
export { probeSource, type ProbeReport, type ProbeStage } from "./probe"
export {
    draftProfileFromSignals,
    draftProfileFromChapterPage,
    deriveChapterShape,
    looksLikeChapterUrl,
    looksLikeReaderPage,
    scoreReaderPage,
    BADGE_THRESHOLD,
    type CaptureSignals,
    type ChapterDraft,
    type ChapterShape
} from "./draft"
