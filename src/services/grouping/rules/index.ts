/**
 * rules/index.ts
 *
 * Registry of all grouping rules, sorted by priority.
 * To add a new rule: import it, instantiate it, add to the array.
 */

import type { GroupingRule } from '../types';
import { ExplicitLinkRule } from './explicit-link';
import { BuilderCodeRule } from './builder-code';
import { PositionLifecycleRule } from './position-lifecycle';
import { TimeProximityRule } from './time-proximity';

/** Returns all rules sorted by priority (lowest runs first). */
export function createDefaultRules(): GroupingRule[] {
  return [
    new ExplicitLinkRule(),
    new BuilderCodeRule(),
    new PositionLifecycleRule(),
    new TimeProximityRule(),
  ].sort((a, b) => a.priority - b.priority);
}
