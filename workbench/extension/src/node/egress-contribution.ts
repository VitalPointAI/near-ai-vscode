import type { BackendRequestAllowedContribution } from '@theia/core/lib/node/request/backend-request-facade.js';
import { allowedUrlPatterns, type OutboundSettings } from './egress.js';

/**
 * Theia's backend request facade refuses every frontend-originated request no BackendRequestAllowedContribution allows (D-42). This is the
 * only contribution in the image: exactly the addresses your organization configured, read once at start, and nothing when none are.
 */
export class SterlingRequestAllowList implements BackendRequestAllowedContribution {
  private readonly patterns: readonly string[];

  constructor(settings: OutboundSettings) {
    this.patterns = allowedUrlPatterns(settings);
  }

  getAllowedUrlPatterns(): string[] {
    return [...this.patterns];
  }
}
