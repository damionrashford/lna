// Mirrors the SDK's SkillIndexEntry so the generated array drops into
// skills({ lazyFrom: { index } }) without a cast.
export type SkillIndexEntry = { name: string; description: string; path?: string };
