export interface RuntimeBuildIdentity {
  runtimeCommit: string;
  skillManifestHash: string;
}

export function getRuntimeBuildIdentity(rootDir: string): RuntimeBuildIdentity;
