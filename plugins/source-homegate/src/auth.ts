import { createHmac } from 'node:crypto';

export interface AuthCfg {
  basic_user: string;
  basic_pass: string;
  /**
   * HMAC-SHA256 key used to derive `X-App-Id`.
   *
   * Reference (homegate-rs, MIT):
   *   src/api/mod.rs line 30 — `SECRET: [u8; 21] = [65, 66, 117, 84, ...]`
   * which decodes to the ASCII string `ABuTZrcTGKN4AwjHed3Hj`.
   */
  app_secret: string;
  /**
   * `X-App-Version` header value AND part of the HMAC payload.
   *
   * Reference (homegate-rs, MIT):
   *   src/api/app_id.rs line 47-50 — `format!("Homegate/12.6.0/12060003/Android/{}", 30)`
   */
  app_version: string;
  /**
   * `User-Agent` header value AND part of the HMAC payload.
   *
   * Reference (homegate-rs, MIT):
   *   src/api/mod.rs line 37 — `USER_AGENT: &str = "homegate.ch App Android"`
   */
  user_agent: string;
}

export function basicAuthHeader(cfg: AuthCfg): string {
  return `Basic ${Buffer.from(`${cfg.basic_user}:${cfg.basic_pass}`).toString('base64')}`;
}

/**
 * `X-App-Id` is NOT a raw HMAC hex digest. It is a HOTP-style dynamic-truncation
 * of HMAC-SHA256, formatted as a signed decimal integer.
 *
 * Algorithm (ported verbatim from homegate-rs `src/api/app_id.rs`, MIT):
 *
 *   1. minute  = ceil(epoch_seconds / 60)            (f64 -> ceil)
 *   2. payload = USER_AGENT + APP_VERSION + minute   (string concatenation, no separators)
 *   3. mac     = HMAC-SHA256(SECRET, payload)        (32 bytes)
 *   4. offset  = mac[31] & 0x0F                      (HOTP-style dynamic offset, 0..=15)
 *   5. buf     = mac[offset..offset+4]               (4 bytes)
 *   6. buf[0] &= 0xFF                                (no-op; preserved from reference)
 *   7. n       = BigEndian::read_i32(buf)            (SIGNED 32-bit)
 *   8. return format!("{}", n)                       (decimal, may be negative)
 *
 * NOTE: the offset is bounded to 0..=15, so reading 4 bytes from
 * mac[offset..offset+4] never goes past the end of a 32-byte HMAC (max
 * read = mac[15..19]).
 *
 * Reference (homegate-rs, MIT):
 *   src/api/app_id.rs lines 12-45 (`calculate_hmac` + `calculate_app_id`).
 *
 * Known-good vector from the same file (line 58-67):
 *   time = 2022-01-25T01:30:56 UTC  =>  app_id = "1926888397"
 * This is asserted in `test/auth.test.ts`.
 */
export function appIdHeader(cfg: AuthCfg, _method: string, _path: string, epochSeconds: number): string {
  const minute = Math.ceil(epochSeconds / 60);
  const payload = `${cfg.user_agent}${cfg.app_version}${minute}`;
  const mac = createHmac('sha256', cfg.app_secret).update(payload).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const buf = Buffer.alloc(4);
  buf[0] = mac[offset]!;
  buf[1] = mac[offset + 1]!;
  buf[2] = mac[offset + 2]!;
  buf[3] = mac[offset + 3]!;
  // buf[0] &= 0xFF is a no-op (Buffer bytes are already u8); preserved for parity with the reference.
  buf[0] = buf[0]! & 0xff;
  const n = buf.readInt32BE(0); // SIGNED, may be negative
  return n.toString(10);
}
