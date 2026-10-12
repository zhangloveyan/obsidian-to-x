export type TextKind = 'unstyled' | 'header-one' | 'header-two' | 'blockquote' | 'ordered-list-item' | 'unordered-list-item';
export interface TextStyle { offset: number; length: number; style: 'Bold' | 'Italic' | 'Strikethrough'; }
export interface TextLink { offset: number; length: number; url: string; }
export type ContentBlock =
  | { type: 'text'; kind: TextKind; text: string; styles: TextStyle[]; links: TextLink[] }
  | { type: 'image'; source: string; alt: string }
  | { type: 'markdown'; markdown: string };
export interface ParsedNote { title: string; cover: string; body: string; blocks: ContentBlock[]; }
export interface MediaAsset { source: string; name: string; mime: string; base64: string; }
export interface UploadedMedia { id: string; localId: string; category: string; entityKey?: string; }
export interface XContent {
  blocks: Array<{ key: string; type: string; text: string; data: Record<string, unknown>; entity_ranges: Array<{ key: number; offset: number; length: number }>; inline_style_ranges: TextStyle[] }>;
  entity_map: Array<{ key: string; value: { type: string; mutability: string; data: Record<string, unknown> } }>;
}
export interface DraftRequest { title: string; blocks: ContentBlock[]; images: MediaAsset[]; cover?: MediaAsset; }
export interface DraftResult { id: string; url: string; }
export interface BrowserBridge {
  evaluate<T>(expression: string): Promise<T>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface ConnectionSettings { nodePath: string; mcpPath: string; token: string; }
export type Progress = (message: string) => void;
export type DiagnosticSink = (event: string, details?: Record<string, string | number | boolean | null>) => void;
