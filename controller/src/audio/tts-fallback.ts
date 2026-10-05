// Expressive engines render square-bracket directions; fallback engines speak
// them literally. Keep the primary text untouched and sanitize only its rescue.
export function fallbackTextFor(requested: string, cloudCueFamily: string | null, text: string): string {
  const expressiveRequest = requested === 'chatterbox'
    || cloudCueFamily === 'fish-s21'
    || cloudCueFamily === 'elevenlabs-v3';
  if (!expressiveRequest || !text) return text;
  return text.replace(/\s*\[[^\]\r\n]{1,80}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// A voice slot the dispatcher can speak with: an engine, plus an optional
// persona-shaped override carrying the voice (and cloud provider) to use.
//
// `personaTts: null` on the hardcoded rungs is load-bearing. speakWith()'s
// per-engine branches only read an override when its `engine` matches, so for
// most rescues an override would be inert; the exception is a cloud persona
// that was pre-flight-rerouted because its provider is unconfigured, where
// forwarding it would re-apply the dead provider instead of the station
// default's credentials the availability probe just validated. Only the
// operator's OWN configured slot carries an override, because there the
// provider/voice is an explicit instruction rather than a leftover.
export interface RescueSlot {
  engine: string;
  personaTts: { engine: string; voice: string; cloudProvider: string } | null;
}

export interface TtsTarget {
  engine: string;
  cloudProvider?: string | null;
}

function slotTarget(slot: RescueSlot): TtsTarget {
  return {
    engine: slot.engine,
    cloudProvider: slot.personaTts?.cloudProvider ?? null,
  };
}

// Engines normally identify a render target on their own. Cloud is the one
// exception: OpenAI-compatible/Fish, ElevenLabs, and OpenAI share the `cloud`
// dispatcher but are independent failure domains. A failed provider must not
// blacklist a healthy provider configured as the operator's rescue.
export function sameTtsTarget(
  left: TtsTarget,
  right: TtsTarget,
  defaultCloudProvider: string | null | undefined = null,
): boolean {
  if (left.engine !== right.engine) return false;
  if (left.engine !== 'cloud') return true;
  const provider = (target: TtsTarget) => target.cloudProvider || defaultCloudProvider || null;
  return provider(left) === provider(right);
}

export interface TtsFallbackConfig {
  enabled?: boolean;
  engine?: string;
  voice?: string;
  cloudProvider?: string;
}

// The operator's configured fallback (settings.tts.fallback) as a slot, or null
// when the block is absent, disabled, or names an engine this build doesn't
// know. Kept beside the chain so "what does a configured fallback look like"
// has exactly one answer, shared by the pre-flight reroute and the mid-render
// rescue.
// A disabled fallback block (`settings.tts.fallback.enabled === false`) bans
// engine substitution outright, not just the operator's own rung. The rescue
// order below hardcodes defaultEngine → Piper → Kokoro, so dropping the
// configured slot alone still lands on Piper and the operator's switch is
// decorative. A station whose voice is a cloned reference would rather lose
// the line than air it in a different voice.
//
// Strict comparison, not `!fallback?.enabled`: an absent block means upstream
// behaviour, and reading it as a ban would silence every station that never
// configured a fallback at all.
export function rescueForbidden(
  fallback: TtsFallbackConfig | null | undefined,
): boolean {
  return fallback?.enabled === false;
}

export function configuredSlot(
  fallback: TtsFallbackConfig | null | undefined,
  engines: readonly string[],
): RescueSlot | null {
  if (!fallback?.enabled) return null;
  const engine = fallback.engine || '';
  if (!engines.includes(engine)) return null;
  return {
    engine,
    personaTts: {
      engine,
      voice: fallback.voice || '',
      cloudProvider: fallback.cloudProvider || 'openai',
    },
  };
}

// Pure ordering logic for speak()'s runtime rescue chain — extracted from
// tts.ts so scripts/tts-fallback.test.ts can pin it without dragging in the
// engine modules (settings reads, venv existsSyncs, live /health probes).
//
// Order: the operator's CONFIGURED fallback first (their explicit second
// choice, engine AND voice), then the configured default engine, then Piper
// (the universal local floor), then Kokoro (for the case where Piper itself was
// the failed primary). The primary, duplicates, and anything the caller's
// `usable` gate rejects are dropped — so the chain never re-attempts the engine
// that just threw, and never attempts one the pre-flight gate already knows
// can't speak. A disabled fallback (`configured` null) reproduces the
// pre-fallback order exactly.
//
// Dedup is by ENGINE, first-wins: when the configured fallback and the default
// engine name the same engine, the configured slot survives and its voice is
// what speaks. Without that, the operator's chosen voice would be silently
// replaced by the engine's global default on exactly the station where both
// were pointed at the same engine.
//
// Note dedup stays engine-keyed even though EXCLUSION is provider-keyed for
// cloud (see sameTtsTarget). That asymmetry is deliberate: a failed provider
// must not blacklist a healthy sibling, but once one cloud rung is in the
// chain a second one buys another network round-trip on the same dispatcher
// while the local floor is still waiting below. One cloud attempt per rescue.
//
// `usable` receives the slot's own cloud provider for the configured rung and
// null for the hardcoded ones — the probe must agree with the call, and a
// hardcoded cloud rung speaks with the station default's credentials.
export function orderedFallbacks(
  primary: string | TtsTarget,
  configured: RescueSlot | null,
  defaultEngine: string | null | undefined,
  usable: (engine: string, cloudProvider?: string | null) => boolean,
  defaultCloudProvider: string | null | undefined = null,
): RescueSlot[] {
  const primaryTarget: TtsTarget = typeof primary === 'string'
    ? { engine: primary }
    : primary;
  const candidates: RescueSlot[] = [
    ...(configured ? [configured] : []),
    ...[defaultEngine, 'piper', 'kokoro'].map((engine) => ({
      engine: engine || '',
      personaTts: null,
    })),
  ];
  const out: RescueSlot[] = [];
  for (const slot of candidates) {
    const { engine } = slot;
    const target = slotTarget(slot);
    if (
      !engine
      || sameTtsTarget(target, primaryTarget, defaultCloudProvider)
      || out.some((s) => s.engine === engine)
    ) continue;
    if (!usable(engine, slot.personaTts?.cloudProvider ?? null)) continue;
    out.push(slot);
  }
  return out;
}
