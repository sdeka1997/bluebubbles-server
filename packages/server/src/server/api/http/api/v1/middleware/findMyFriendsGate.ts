/**
 * Middleware for GET findmy/friends. Before macOS 14.4 friend locations come from the Private API
 * helper, so it must be connected. From 14.4 they are decrypted from Find My's own caches instead.
 * Authentication is required either way.
 */
export const findMyFriendsMiddleware = <T>(isMinSonoma14_4: boolean, authenticated: T[], privateApi: T): T[] =>
    isMinSonoma14_4 ? authenticated : [...authenticated, privateApi];
