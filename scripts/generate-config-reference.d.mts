export type GeneratedArtifacts = Map<string, string>;

export function renderGeneratedArtifacts(): GeneratedArtifacts;
export function checkGeneratedArtifacts(root?: string, artifacts?: GeneratedArtifacts): Promise<string[]>;
export function writeGeneratedArtifacts(root?: string, artifacts?: GeneratedArtifacts): Promise<void>;
