export declare const MIN_NODE_VERSION: string;
export declare function runtimeProblems(version: string, features: { typescript?: unknown }): string[];
export declare function assertSupportedRuntime(): Promise<void>;
