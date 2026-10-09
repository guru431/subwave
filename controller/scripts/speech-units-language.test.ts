// Fork: a set non-English speech language keeps °, % and digit-range dashes as
// written. normalizeForSpeech spelled them as English words for every language
// ("80 percent", "12 degrees", "1969 to 1972"), and the station's Russian F5
// service reads Latin by Russian letter rules. It spells the symbols itself,
// with case agreement (station/tts-f5/f5_numbers.py). English and an unset
// language keep the upstream expansions.
// Run: npm test -- speech-units-language
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeForSpeech } from '../src/audio/speech-text.js';

const russian = 'В 1969–1972 годах влажность 80%, за окном +12°, ночью −3 °C, в Майами 86°F.';

for (const language of ['Russian', 'ru', 'русский', 'French', 'Turkish']) {
  test(`${language}: °, % and year ranges reach the engine as written`, () => {
    assert.equal(normalizeForSpeech(russian, undefined, language), russian);
  });
}

for (const language of ['', 'English', 'en-GB']) {
  test(`English ${JSON.stringify(language)} still spells °, % and ranges as words`, () => {
    assert.equal(
      normalizeForSpeech('40% chance, 18°C, 76 °F, a 45° turn, 1967–1972', undefined, language),
      '40 percent chance, 18 degrees Celsius, 76 degrees Fahrenheit, a 45 degrees turn, '
        + 'nineteen sixty-seven to nineteen seventy-two',
    );
  });
}
