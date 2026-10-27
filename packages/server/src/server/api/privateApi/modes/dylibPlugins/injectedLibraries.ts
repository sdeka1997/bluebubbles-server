export const defaultInjectedLibraries = (dylibPath: string): string[] => [dylibPath];

// The packaged helper has no hard ChatKit imports. Never force-insert the
// Catalyst ChatKit framework: Sequoia rejects it before the helper can load.
export const messagesInjectedLibraries = (dylibPath: string): string[] => defaultInjectedLibraries(dylibPath);

export const injectedLibrariesEnvironmentValue = (libraries: string[]): string => libraries.join(":");
