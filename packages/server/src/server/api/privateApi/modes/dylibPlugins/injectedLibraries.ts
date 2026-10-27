export const defaultInjectedLibraries = (dylibPath: string): string[] => [dylibPath];

// Messages already links ChatKit itself. Force-inserting the Catalyst framework
// by path is rejected on Sequoia before the helper can load.
export const messagesInjectedLibraries = (dylibPath: string): string[] => defaultInjectedLibraries(dylibPath);

export const injectedLibrariesEnvironmentValue = (libraries: string[]): string => libraries.join(":");
