// Fork: a set non-English speech language keeps °, %, $, mph, km/h, & and
// digit-range dashes as written. normalizeForSpeech spelled them as English
// words for every language ("80 percent", "12 degrees", "1969 to 1972",
// "5 dollars", "Al Bano and Romina Power"), and the station's Russian F5
// service reads Latin by Russian letter rules. It spells the symbols itself,
// with case agreement (station/tts-f5/f5_numbers.py), and its pronunciation
// dictionary keys names on "&". English and an unset language keep the
// upstream expansions.
// Run: npm test -- speech-units-language
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeForSpeech } from '../src/audio/speech-text.js';

const russian = 'В 1969–1972 годах влажность 80%, за окном +12°, ночью −3 °C, в Майами 86°F.';
const money = 'Сингл собрал $5 млн, билет стоил $20, гнали под 60 mph и 90 km/h — '
  + 'это Al Bano & Romina Power, чистый R&B.';

for (const language of ['Russian', 'ru', 'русский', 'French', 'Turkish']) {
  test(`${language}: °, % and year ranges reach the engine as written`, () => {
    assert.equal(normalizeForSpeech(russian, undefined, language), russian);
  });

  test(`${language}: $, mph, km/h and & reach the engine as written`, () => {
    assert.equal(normalizeForSpeech(money, undefined, language), money);
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

  test(`English ${JSON.stringify(language)} still spells $, mph, km/h and & as words`, () => {
    assert.equal(
      normalizeForSpeech('$5 million, $100k, 60 mph, 90 km/h, Florence & the Machine', undefined, language),
      '5 million dollars, 100 thousand dollars, 60 miles per hour, 90 kilometers per hour, '
        + 'Florence and the Machine',
    );
  });
}
