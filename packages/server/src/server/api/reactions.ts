export const STANDARD_REACTIONS = [
    "love",
    "like",
    "dislike",
    "laugh",
    "emphasize",
    "question",
    "-love",
    "-like",
    "-dislike",
    "-laugh",
    "-emphasize",
    "-question"
] as const;

const standardReactionSet = new Set<string>(STANDARD_REACTIONS);
const emojiPattern = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const maxEmojiCodePoints = 32;

export const isStandardReaction = (reaction: string): boolean => standardReactionSet.has(reaction);

export const isValidReaction = (reaction: unknown, allowCustomEmoji: boolean): reaction is string => {
    if (typeof reaction !== "string" || reaction.length === 0 || reaction !== reaction.trim()) return false;
    if (isStandardReaction(reaction)) return true;
    if (!allowCustomEmoji) return false;

    const emoji = reaction.startsWith("-") ? reaction.slice(1) : reaction;
    if (!emoji || [...emoji].length > maxEmojiCodePoints) return false;
    if ([...graphemeSegmenter.segment(emoji)].length !== 1) return false;
    return emojiPattern.test(emoji);
};

export const toHelperReaction = (
    reaction: string
): { reactionType: string; reactionEmoji?: string } => {
    if (isStandardReaction(reaction)) return { reactionType: reaction };

    const isRemoval = reaction.startsWith("-");
    return {
        reactionType: isRemoval ? "-emoji" : "emoji",
        reactionEmoji: isRemoval ? reaction.slice(1) : reaction
    };
};

export const serializeAssociatedReaction = (
    reactionType: string | null,
    reactionEmoji: string | null
): string | null => {
    if (!reactionEmoji) return reactionType;
    return reactionType === "-emoji" || reactionType === "3006" ? `-${reactionEmoji}` : reactionEmoji;
};
