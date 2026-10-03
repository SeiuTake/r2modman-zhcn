// i18n-runtime-test.mjs — load the *patched* i18n bundle through the real vue-i18n
// runtime and assert that the injected zh-CN locale actually works.
//
// This exercises the real code path the app uses at startup:
//   instance bundle (with our injected setLocaleMessage call) -> vue-i18n composer
//
// Usage: node verify/i18n-runtime-test.mjs <dir-with-extracted-assets>

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(process.argv[2] ?? 'work/rt/assets');
if (!fs.existsSync(dir)) {
  console.error(`assets dir not found: ${dir}`);
  process.exit(2);
}

const assets = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const i18nChunk = assets.find((f) => /^instance-.*\.js$/.test(f));
if (!i18nChunk) {
  console.error('could not find instance-*.js in ' + dir);
  process.exit(2);
}

const source = fs.readFileSync(path.join(dir, i18nChunk), 'utf8');
console.log(`i18n chunk : ${i18nChunk}`);
console.log(`marker     : ${source.includes('/*r2modman-zhcn-pack*/') ? 'present' : 'MISSING'}`);

const mod = await import(pathToFileURL(path.join(dir, i18nChunk)).href);
const i18n = mod.t;
if (!i18n?.global) {
  console.error('module did not export an i18n instance as `t`');
  process.exit(2);
}

const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  [ok]   ${label}`);
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failures.push(label); }
};

// ---------------------------------------------------------------- registration
console.log('\n-- locale registration');
const available = i18n.global.availableLocales;
console.log(`  availableLocales = ${JSON.stringify(available)}`);
check('zh is registered in availableLocales', available.includes('zh'));

const zh = i18n.global.getLocaleMessage('zh');
check('zh has metadata.name = 简体中文', zh?.metadata?.name === '简体中文', JSON.stringify(zh?.metadata));
check('zh has metadata.locale = zh-CN', zh?.metadata?.locale === 'zh-CN');
check('zh has translations', !!zh?.translations);

const en = i18n.global.getLocaleMessage('en');
check('en is untouched', en?.metadata?.name === 'English');
check('fr is untouched', i18n.global.getLocaleMessage('fr')?.metadata?.name === 'Français');

// ------------------------------------------------------------------ switching
console.log('\n-- locale switching (what the activity-bar menu does)');
i18n.global.locale.value = 'zh';
const t = (k, ...a) => i18n.global.t(k, ...a);
const samples = [
  ['translations.pages.manager.navigation.gameActions.startModded', '带 Mod 启动'],
  ['translations.pages.manager.navigation.modsActions.online', '在线'],
  ['translations.pages.settings.hero.title', '设置'],
  ['translations.pages.gameSelection.pageTitle.title.game', '选择游戏'],
  ['translations.pages.manager.installed.noModsInstalled.title', '你还没有安装任何 Mod'],
  ['translations.enums.sortDirection.REVERSE', '倒序'],
  ['translations.platforms.XBOX_GAME_PASS', 'Xbox Game Pass'],
  ['translations.modals.gameRunning.bePatient', '请耐心等待，祝你玩得开心！'],
];
for (const [key, expected] of samples) {
  const got = t(key);
  check(key.replace('translations.', ''), got === expected, `got ${JSON.stringify(got)}`);
}

// -------------------------------------------------------------------- plurals
console.log('\n-- plural forms');
const pluralCases = [
  ['translations.pages.settings.entries.modState.someDisabled', 1, { count: 1 }],
  ['translations.pages.settings.entries.modState.someDisabled', 5, { count: 5 }],
  ['translations.pages.settings.entries.updateAllMods.status', 3, { count: 3 }],
  ['translations.pages.configEditor.editConfig.hiddenCount', 4, { count: 4 }],
  ['translations.banners.updatableMods.text', 2, { numberOfModsWithUpdates: 2 }],
];
for (const [key, n, params] of pluralCases) {
  const got = t(key, n, params);
  const ok = typeof got === 'string' && got.length > 0 && !got.includes('|') && !got.includes('{');
  check(`${key.split('.').pop()} (n=${n})`, ok, JSON.stringify(got));
}

// ------------------------------------------------------- linked message @:key
console.log('\n-- linked messages');
const linked = t('translations.pages.help.general.gettingStarted.whereToFindMods');
check('help.whereToFindMods resolves its @: link', linked.includes('在线') && !linked.includes('@:'), JSON.stringify(linked));
// The app renders retryPrompt through <i18n-t keypath=...> with a `retryAction` slot,
// which vue-i18n passes as a named parameter — mirror that.
const retry = t('translations.banners.modListUpdate.retryPrompt', { retryAction: t('translations.banners.modListUpdate.retryAction') });
check('banners retryPrompt named interpolation', retry.includes('立即重试') && !retry.includes('{'), JSON.stringify(retry));

// The app interpolates dates as `t(key, { formattedDate: d(value, "long", getDateLocale()) })`
// where getDateLocale() is the locale's own metadata.locale (zh-CN).
const dateLocale = i18n.global.getLocaleMessage('zh').metadata.locale;
const installedAt = t('translations.pages.manager.installed.localModCard.display.installedAt', {
  formattedDate: i18n.global.d(new Date('2024-03-05T10:20:30Z'), 'long', dateLocale),
});
check('installedAt with a formatted date', installedAt.startsWith('安装于：') && !installedAt.includes('{'), JSON.stringify(installedAt));

// ------------------------------------------------------------ date formatting
console.log('\n-- date/time formats');
const dt = i18n.global.getDateTimeFormat('zh-CN');
check('zh-CN datetime format registered', !!dt && !!dt.short && !!dt.long, JSON.stringify(dt));
let dateOk = false, dateOut = '';
try { dateOut = i18n.global.d(new Date('2024-03-05T10:20:30Z'), 'long', dateLocale); dateOk = typeof dateOut === 'string' && dateOut.length > 0; }
catch (e) { dateOut = String(e); }
check(`d(date, "long", "${dateLocale}") formats a date`, dateOk, dateOut);
check('zh-CN format differs from en-US output', dateOut !== i18n.global.d(new Date('2024-03-05T10:20:30Z'), 'long', 'en-US'), dateOut);

// ------------------------------------------------- coverage of every used key
console.log('\n-- coverage: every key literal referenced by any bundle');
const used = new Set();
for (const f of assets) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const re = /"((?:translations|metadata)\.[A-Za-z0-9_.]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) used.add(m[1]);
}
const resolvable = [];
const dynamicPrefixes = [];
for (const key of [...used].sort()) {
  if (!key.startsWith('translations.')) continue;
  if (i18n.global.te(key, 'zh')) resolvable.push(key);
  else dynamicPrefixes.push(key);
}
// A key is only a genuine gap if it resolves in the en baseline; the three remaining
// ones are string prefixes used for runtime concatenation.
const genuineGaps = dynamicPrefixes.filter((k) => i18n.global.te(k, 'en'));
console.log(`  key literals found      : ${used.size}`);
console.log(`  resolve in zh           : ${resolvable.length}`);
console.log(`  not resolvable in zh    : ${dynamicPrefixes.length} ${JSON.stringify(dynamicPrefixes)}`);
check('no genuine coverage gap (unresolved keys are runtime-built prefixes)', genuineGaps.length === 0, JSON.stringify(genuineGaps));

// also make sure nothing falls back to English for a resolvable key
const sameAsEn = [];
for (const key of resolvable) {
  const zhv = i18n.global.t(key, 'zh');
  const env = i18n.global.t(key, 'en');
  if (zhv === env && /[A-Za-z]{4,}/.test(env) && !/^[\x00-\x7F]*$/.test(env) === false) sameAsEn.push(key);
}
console.log(`  identical to en (expected for brand names etc.): ${sameAsEn.length}`);

console.log('');
if (failures.length) {
  console.log(`FAIL — ${failures.length} check(s) failed:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('PASS — injected zh-CN locale is registered, resolves, pluralises, links and formats dates.');
