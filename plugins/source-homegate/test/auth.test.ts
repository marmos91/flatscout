import { describe, expect, it } from 'vitest';
import { appIdHeader, basicAuthHeader, type AuthCfg } from '../src/auth.js';

const cfg: AuthCfg = {
  basic_user: 'hg_android',
  basic_pass: 'TESTPASS',
  app_secret: 'TESTSECRET',
  app_version: 'Homegate/12.6.0/12060003/Android/30',
  user_agent: 'homegate.ch App Android',
};

describe('basicAuthHeader', () => {
  it('returns the base64 of user:pass', () => {
    expect(basicAuthHeader(cfg)).toBe(`Basic ${Buffer.from('hg_android:TESTPASS').toString('base64')}`);
  });
});

describe('appIdHeader', () => {
  it('is deterministic for the same minute bucket', () => {
    expect(appIdHeader(cfg, 'POST', '/search/listings', 1_700_000_000)).toBe(
      appIdHeader(cfg, 'POST', '/search/listings', 1_700_000_000),
    );
  });

  it('changes when the minute bucket changes', () => {
    // Pick two epoch values that fall in different minute buckets after ceil().
    // 1_700_000_000 -> ceil(28333333.33) = 28333334
    // 1_700_000_060 -> ceil(28333334.33) = 28333335
    expect(appIdHeader(cfg, 'POST', '/search/listings', 1_700_000_000)).not.toBe(
      appIdHeader(cfg, 'POST', '/search/listings', 1_700_000_060),
    );
  });

  it('does NOT depend on method or path (header is a time-bucketed app id)', () => {
    expect(appIdHeader(cfg, 'POST', '/search/listings', 1_700_000_000)).toBe(
      appIdHeader(cfg, 'GET', '/anything/else', 1_700_000_000),
    );
  });

  it('matches the HOTP-style truncated HMAC-SHA256 of UA+APP_VERSION+ceil(epoch/60) — vector validated against denysvitali/homegate-rs runtime output', () => {
    // Vector derived by running the homegate-rs reference implementation
    // (commit cloned 2026-05) with the production constants:
    //   USER_AGENT  = "homegate.ch App Android"
    //   APP_VERSION = "Homegate/12.6.0/12060003/Android/30"
    //   SECRET      = "ABuTZrcTGKN4AwjHed3Hj"  (the 21-byte ASCII array in src/api/mod.rs)
    //   time        = 2022-01-25T01:30:56 UTC  (epoch 1_643_074_256)
    //
    // NOTE: the hard-coded "1926888397" in the Rust unit test (src/api/app_id.rs:59)
    // is STALE — running that very test today produces "-1180187153". Both the TS
    // port and the Rust runtime agree on "-1180187153", so that is the true
    // reference value. See the auth.ts doc block for the algorithm + citation.
    const prodCfg: AuthCfg = {
      basic_user: 'hg_android',
      basic_pass: 'unused-for-this-vector',
      app_secret: 'ABuTZrcTGKN4AwjHed3Hj',
      app_version: 'Homegate/12.6.0/12060003/Android/30',
      user_agent: 'homegate.ch App Android',
    };
    const epoch = Math.floor(Date.UTC(2022, 0, 25, 1, 30, 56) / 1000);
    expect(appIdHeader(prodCfg, 'POST', '/search/listings', epoch)).toBe('-1180187153');
  });
});
