// Plan 5 Task 1: L_h and L_c (glossary §17; X-53; I18N-02), and user.json's wake and notification keys (glossary §17 defaults, X-52).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLang, resolveHumanLang } from '../../src/i18n/locale.js';
import { loaderLang } from '../../src/claude/text/claudeText.js';
import { readUserJson } from '../../src/claude/wire/pluginData.js';
import { LANGS } from '../../src/i18n/render.js';

test('resolveHumanLang is user → team → OS → en and claudeLang maps L_h to en or ko', () => {
  // The X-53 divergence: the daemon reads the team config, the loader cannot.
  assert.equal(resolveHumanLang({ user: null, team: 'ko', osLocale: 'en-US' }).lang, 'ko');
  assert.equal(loaderLang(null, 'en-US'), 'en');
  assert.deepEqual(resolveHumanLang({ user: 'en', team: 'ko', osLocale: 'ko-KR' }), { lang: 'en', invalid: [] });
  assert.deepEqual(resolveHumanLang({ user: 'xx', team: null, osLocale: 'ko-KR' }), { lang: 'ko', invalid: ['user'] });
  assert.deepEqual(resolveHumanLang({ user: 'xx', team: 'yy', osLocale: null }), { lang: 'en', invalid: ['user', 'team'] });
  assert.deepEqual(resolveHumanLang({ user: null, team: null, osLocale: null }), { lang: 'en', invalid: [] });
  assert.deepEqual(resolveHumanLang({ user: 'xx', team: 'fr', osLocale: 'ko-KR' }), { lang: 'fr', invalid: ['user'] });
  // OS locales of the six languages, POSIX and BCP 47 forms; anything else is en.
  const os = (osLocale: string): string => resolveHumanLang({ user: null, team: null, osLocale }).lang;
  assert.equal(os('ko_KR.UTF-8'), 'ko');
  assert.equal(os('zh-CN'), 'zh-CN');
  assert.equal(os('zh_CN.GB2312'), 'zh-CN');
  assert.equal(os('zh-Hans-CN'), 'zh-CN');
  assert.equal(os('ja_JP'), 'ja');
  assert.equal(os('fr-CA'), 'fr');
  assert.equal(os('es-419'), 'es');
  assert.equal(os('de-DE'), 'en');
  assert.equal(os('zh-TW'), 'en');
  assert.equal(os('C'), 'en');
  assert.equal(os(''), 'en');
  assert.equal(claudeLang('ko'), 'ko');
  assert.equal(claudeLang('en'), 'en');
  for (const l of LANGS.filter((x) => x !== 'en' && x !== 'ko')) assert.equal(claudeLang(l), 'en', l);
});

test('readUserJson reads the wake and notification keys', () => {
  const p = readUserJson('{"wake":{"enabled":false,"maxPerSeatPerHour":2},"notifications":{"os":false}}');
  assert.equal(p.wakeEnabled, false);
  assert.equal(p.wakeMaxPerSeatPerHour, 2);
  assert.equal(p.notificationsOs, false);
  const d = readUserJson('{}');
  assert.equal(d.wakeEnabled, true);
  assert.equal(d.wakeMaxPerSeatPerHour, 4);
  assert.equal(d.notificationsOs, true);
  assert.equal(readUserJson('{"language":"xx"}').language, null);
  for (const l of LANGS) assert.equal(readUserJson(JSON.stringify({ language: l })).language, l);
  assert.equal(readUserJson('{"wake":{"maxPerSeatPerHour":-1}}').wakeMaxPerSeatPerHour, 4);
  assert.equal(readUserJson('{"wake":{"maxPerSeatPerHour":2.5}}').wakeMaxPerSeatPerHour, 4);
  assert.equal(readUserJson('{"notifications.os": false}').notificationsOs, false);
});
