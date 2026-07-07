/**
 * resolveActiveEngine — effective-engine resolution + native fallback.
 *
 * The helper is the single source of truth for "which engine actually
 * runs", mirroring `LifecycleOwner.initialize()`'s
 * `engine === 'rs' ? loadNativeAddon() : null` branch. These tests pin
 * the *preference* via `SPAG_ENGINE` (highest-precedence input) and
 * assert the contract; native availability is fixed for the process
 * (`loadNativeAddon()` is memoized) so the fallback is asserted as an
 * invariant rather than by toggling the addon.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveActiveEngine } from '../native.js';

describe('resolveActiveEngine', () => {
  let savedEngine: string | undefined;
  let savedLegacy: string | undefined;

  beforeEach(() => {
    savedEngine = process.env.SPAG_ENGINE;
    savedLegacy = process.env.SPAG_NATIVE_INGEST;
    delete process.env.SPAG_ENGINE;
    delete process.env.SPAG_NATIVE_INGEST;
  });

  afterEach(() => {
    if (savedEngine === undefined) delete process.env.SPAG_ENGINE;
    else process.env.SPAG_ENGINE = savedEngine;
    if (savedLegacy === undefined) delete process.env.SPAG_NATIVE_INGEST;
    else process.env.SPAG_NATIVE_INGEST = savedLegacy;
  });

  test('a `ts` preference always runs ts (no native needed)', () => {
    process.env.SPAG_ENGINE = 'ts';
    const info = resolveActiveEngine();
    assert.equal(info.preference, 'ts');
    assert.equal(info.engine, 'ts');
  });

  test('an `rs` preference runs rs iff the native addon is available', () => {
    process.env.SPAG_ENGINE = 'rs';
    const info = resolveActiveEngine();
    assert.equal(info.preference, 'rs');
    assert.equal(info.engine, info.nativeAvailable ? 'rs' : 'ts');
  });

  test('the effective engine never claims rs without a loaded addon', () => {
    for (const pref of ['ts', 'rs'] as const) {
      process.env.SPAG_ENGINE = pref;
      const info = resolveActiveEngine();
      if (info.engine === 'rs') {
        assert.equal(info.nativeAvailable, true, 'engine "rs" requires nativeAvailable');
      }
    }
  });

  test('nativeVersion is a string exactly when nativeAvailable', () => {
    const info = resolveActiveEngine();
    assert.equal(typeof info.nativeAvailable, 'boolean');
    if (info.nativeAvailable) {
      assert.equal(typeof info.nativeVersion, 'string');
    } else {
      assert.equal(info.nativeVersion, null);
    }
  });
});
