/** Options for cacheable fetch functions. */
export interface FetchOpts {
  /** Bypass cache and fetch fresh from network. Use after mutations. */
  forceNetwork?: boolean;
}
