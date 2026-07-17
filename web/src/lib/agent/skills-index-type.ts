// The one shape the generated skills index conforms to — mirrors the SDK's SkillIndexEntry so the
// generated array drops straight into skills({ lazyFrom: { index } }) with no cast.
export type SkillIndexEntry = { name: string; description: string; path?: string };
