export type Level = 'info' | 'warn' | 'error' | 'success';
export type Category = 'SYSTEM' | 'AUTH' | 'WORKFLOW' | 'CONTROL';

export interface FeedItem {
  ts: string;
  level: Level;
  category: Category;
  message: string;
  meta?: string | null;
}
