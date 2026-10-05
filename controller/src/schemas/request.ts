// Shared listener-request schema — the public request box's POST /request body
// ({ text, name }). One box per skin, six boxes total, all posting the same two
// fields; the caps used to live server-side only (a slice, not a rule), so the
// boxes invited text the booth then silently cut. Executed on BOTH sides: the
// controller runs it at the route boundary (middleware/validate.ts), and the
// web player runs it once in PlayerCore's submitRequest action — the one
// chokepoint every skin's box already goes through — so a refusal reads as a
// plain message before the network is ever touched.
//
// What this schema deliberately does NOT own: the on-air safety pipeline.
// Injection stripping, scripted-opener cuts, reserved-name screening and the
// 'anon' fallback are guard POLICY over accepted input (util/request-guard.ts,
// pinned by scripts/request-guard.test.ts) — they need server state (the
// persona roster) and they repair rather than refuse by design. The schema
// answers only "is this a well-formed request", the guard answers "what may
// reach the air".
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle. Enforced by controller/eslint.config.mjs and gen-schemas.ts.
import { z } from 'zod';

// Homed here so the route, the guard and the browser share one figure.
// middleware/ratelimit.ts used to own the text cap (as a slice — over-long
// text was silently truncated, which could cut a request mid-thought and have
// the DJ answer half of it); util/request-guard.ts keeps applying the name cap
// as its belt (its NAME_MAX is an alias of this).
export const REQUEST_TEXT_MAX = 280;
export const REQUEST_NAME_MAX = 40;

// Explicit null reads as absent, as the `typeof x === 'string' ? x : ''`
// readers this replaces always did. (Named per-module: the mirror is one flat
// file.)
const requestNullToUndefined = (v: unknown) => (v == null ? undefined : v);

// Messages are listener-facing: the pre-flight gate in the player surfaces
// them verbatim, so each one has to stand alone without a field prefix.
// 'Empty request' keeps the historical wire message for API callers.
//
// The SERVER half of that promise is middleware/validate.ts's
// validatePublicBody, not the ordinary validateBody — firstMessage prefixes the
// dotted path unconditionally, so routing this schema through the operator
// middleware would put "text: " in front of every one of these strings on the
// wire while the browser (which reads issues[0].message) saw them bare. Two
// sides, one schema, two different messages, is exactly what these conversions
// exist to prevent.
export const listenerRequestSchema = z.object({
  text: z
    .string({ error: 'Empty request' })
    .trim()
    .min(1, 'Empty request')
    .max(REQUEST_TEXT_MAX, `Keep it under ${REQUEST_TEXT_MAX} characters.`),
  // Optional decoration, but a refusal beats the old silent slice-to-40 — and
  // no `.catch()`, which could not tell a wrong type from a too-long value
  // (the imaging description lesson). Reserved names and junk scripts are the
  // guard's business, downstream of acceptance.
  name: z.preprocess(
    requestNullToUndefined,
    z
      .string({ error: 'Names must be plain text.' })
      .trim()
      .max(REQUEST_NAME_MAX, `Keep the name under ${REQUEST_NAME_MAX} characters.`)
      .default(''),
  ),
  // Exact request: the listener picked the track from the player's suggestion,
  // and its collection id was already checked against the library (the room's
  // GET /resolve). Optional — a free-text request stays a first-class path;
  // this one only removes the guesswork where there is nothing left to guess.
  //
  // Capped not because Navidrome ids are never longer, but because the value
  // travels into a Subsonic query: without a ceiling anything fits here.
  songId: z.preprocess(
    requestNullToUndefined,
    z
      .string({ error: 'Track id must be plain text.' })
      .trim()
      .max(64, 'Track id is too long.')
      .optional(),
  ),
});
