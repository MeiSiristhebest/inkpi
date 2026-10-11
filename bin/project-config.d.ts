export interface InkPiProjectConfig {
  name?: string;
  version?: string;
  defaultModel?: string;
  typography?: false | {
    mode?: 'chinese' | 'western' | 'none';
    indentString?: string;
    [key: string]: unknown;
  };
  plugins?: string[];
  [key: string]: unknown;
}

export function loadProjectConfig(projectRoot?: string): InkPiProjectConfig | undefined;
