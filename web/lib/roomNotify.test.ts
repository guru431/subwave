// Решение о том, что показывать вместо переключателя уведомлений. Приём — как
// в roomRules.test.ts. Запуск:  npx tsx web/lib/roomNotify.test.ts

import assert from 'node:assert/strict';
import { notifyState, type NotifyEnv } from './roomNotify';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

const BASE: NotifyEnv = { supported: true, permission: 'default', ios: false, standalone: false };

test('разрешение дано — переключатель обычный', () => {
  assert.equal(notifyState({ ...BASE, permission: 'granted' }), 'ready');
});

test('разрешение не спрашивали — предлагаем спросить', () => {
  assert.equal(notifyState(BASE), 'ask');
});

test('запрет браузера назван запретом, а не поломкой', () => {
  assert.equal(notifyState({ ...BASE, permission: 'denied' }), 'denied');
});

test('iOS во вкладке отправляет ставить приложение', () => {
  // в обычной вкладке Safari уведомлений нет вовсе: показать там переключатель
  // значит показать кнопку, которая молча ничего не делает
  assert.equal(notifyState({ ...BASE, ios: true, standalone: false }), 'ios-install');
});

test('iOS в установленном приложении работает как все', () => {
  assert.equal(notifyState({ ...BASE, ios: true, standalone: true, permission: 'granted' }), 'ready');
});

test('браузер без Notification честно говорит, что не умеет', () => {
  assert.equal(notifyState({ ...BASE, supported: false }), 'unsupported');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
