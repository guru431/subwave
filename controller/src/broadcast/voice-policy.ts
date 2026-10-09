// Station-wide voice switch (`settings.tts.enabled`). Call sites ask; this
// module answers, so the policy lives in one place.
//
// The gate sits BEFORE generation, not at speak(), or the LLM writes every
// script and throws it away. Picks, listener requests and jingles keep running
// with voice off; only the spoken line is dropped. Manual /dj/segment triggers
// bypass this entirely. Read live, so the toggle applies on the next tick.

import * as settings from '../settings.js';
import { rescueForbidden } from '../audio/tts-fallback.js';
import { personaEngineKnownDown } from '../audio/tts.js';

// Absent/non-boolean reads as ON, so an upgrade changes nothing.
export function voiceEnabled(): boolean {
  return settings.get()?.tts?.enabled !== false;
}

// May an AUTONOMOUS talk moment start? Manual runners must NOT call this.
//
// Fork (C05): also no while substitution is banned and the on-air voice's
// engine is KNOWN down — that line can only be dropped at render, so writing it
// is the waste this gate exists to prevent. Unknown (probe not answered yet)
// stays open. Air-time backstops for lines ALREADY rendered ask voiceEnabled()
// instead: a WAV on disk needs no engine.
export function autoVoiceAllowed(): boolean {
  if (!voiceEnabled()) return false;
  return !(rescueForbidden(settings.get()?.tts?.fallback) && personaEngineKnownDown());
}

export function voiceStatus() {
  return { enabled: voiceEnabled() };
}
