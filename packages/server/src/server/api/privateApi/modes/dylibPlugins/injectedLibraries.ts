export const CHATKIT_PATH = "/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit";

export const defaultInjectedLibraries = (dylibPath: string): string[] => [dylibPath];

export const messagesInjectedLibraries = (dylibPath: string): string[] => [CHATKIT_PATH, dylibPath];

export const injectedLibrariesEnvironmentValue = (libraries: string[]): string => libraries.join(":");
