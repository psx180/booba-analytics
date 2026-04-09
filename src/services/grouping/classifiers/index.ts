/**
 * classifiers/index.ts
 *
 * Registry of all trade type classifiers.
 * Order matters: the service tries each classifier and picks the
 * highest-confidence match. The DirectionalClassifier always matches
 * as a fallback with confidence 0.5.
 */

import type { GroupClassifier } from '../types';
import {
  MarketMakingClassifier,
  ScalpClassifier,
  ScaledDirectionalClassifier,
  DeltaNeutralClassifier,
  CarryTradeClassifier,
  DirectionalClassifier,
} from './trade-type';

/** Returns all classifiers. */
export function createDefaultClassifiers(): GroupClassifier[] {
  return [
    new MarketMakingClassifier(),
    new ScalpClassifier(),
    new ScaledDirectionalClassifier(),
    new DeltaNeutralClassifier(),
    new CarryTradeClassifier(),
    new DirectionalClassifier(), // fallback — always matches
  ];
}