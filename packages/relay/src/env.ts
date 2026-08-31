/** The subset of the Workers Rate Limiting binding this relay uses. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Apple Team ID. JWT iss. wrangler secret. */
  APNS_TEAM_ID: string;
  /** Key ID of the APNs Auth Key. JWT header kid. wrangler secret. */
  APNS_KEY_ID: string;
  /** Full PEM of the .p8. Set with: pnpm exec wrangler secret put APNS_SIGNING_KEY < AuthKey_XXX.p8 */
  APNS_SIGNING_KEY: string;
  /** Bundle ID of the iOS app. vars in wrangler.jsonc. */
  APNS_TOPIC: string;
  /** ratelimits in wrangler.jsonc. May be undefined when running locally. */
  PUSH_LIMITER?: RateLimiter;
}
