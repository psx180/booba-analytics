/**
 * Tilt module barrel + default detector factory.
 *
 * The analytics service uses createDefaultTiltDetector(). Swapping a future
 * ML-based detector in is a one-line change here — no downstream consumers
 * need to be touched.
 */

import { HeuristicScorer } from './heuristic-scorer';
import { ChangePointDetector } from './change-point';
import type { TiltDetector } from './types';

export { HeuristicScorer } from './heuristic-scorer';
export { ChangePointDetector } from './change-point';
export { TiltService } from './tilt-service';
export type {
  TiltDetector,
  TiltDetectionResult,
  TiltScore,
  TiltEpisode,
  TiltFeatures,
} from './types';

/** Default: change-point detector (statistically rigorous). */
export function createDefaultTiltDetector(): TiltDetector {
  return new ChangePointDetector({ verbose: false });
}

/** Alternative: heuristic scorer (fast, simple — useful for comparison). */
export function createHeuristicTiltDetector(): TiltDetector {
  return new HeuristicScorer();
}
