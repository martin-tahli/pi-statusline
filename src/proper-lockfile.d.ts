declare module "proper-lockfile" {
  export function lockSync(path: string, options?: {
    realpath?: boolean;
    stale?: number;
    retries?: number;
  }): () => void;
}
