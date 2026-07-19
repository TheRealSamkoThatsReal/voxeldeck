// Unit tests for the singleplayer launcher's pure logic (mojang.js + loaders.js).
// Exercises OS-rule evaluation, maven-path resolution, the library classpath/
// natives split, launch-spec assembly, and loader-profile merging — all without
// any network, disk, or Electron.
const path = require('path');
const mojang = require(path.join(__dirname, '..', 'src', 'main', 'mojang.js'));
const loaders = require(path.join(__dirname, '..', 'src', 'main', 'loaders.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } }

// ---- OS rule evaluation ----
ok('no rules → allowed', mojang.rulesAllow(undefined) === true && mojang.rulesAllow([]) === true);
ok('allow-only osx is denied on linux',
  mojang.rulesAllow([{ action: 'allow', os: { name: 'osx' } }], { platform: 'linux' }) === false);
ok('allow-only linux is allowed on linux',
  mojang.rulesAllow([{ action: 'allow', os: { name: 'linux' } }], { platform: 'linux' }) === true);
ok('allow-all then disallow-osx is denied on osx',
  mojang.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], { platform: 'darwin' }) === false);
ok('feature-gated rule (demo) is skipped by default',
  mojang.rulesAllow([{ action: 'allow', features: { is_demo_user: true } }]) === false);

// ---- maven coordinates → repo paths ----
ok('plain maven path',
  mojang.mavenToPath('com.google.code.gson:gson:2.10') === 'com/google/code/gson/gson/2.10/gson-2.10.jar');
ok('classifier maven path',
  mojang.mavenToPath('org.lwjgl:lwjgl:3.3.1:natives-linux') === 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar');
ok('@ext maven path',
  mojang.mavenToPath('net.minecraft:client:1.20@txt') === 'net/minecraft/client/1.20/client-1.20.txt');
ok('mavenKey is group:artifact', mojang.mavenKey('org.lwjgl:lwjgl:3.3.1:natives-linux') === 'org.lwjgl:lwjgl');

// ---- library resolution: classpath vs natives, rules, dedupe ----
const libs = [
  { name: 'com.google.code.gson:gson:2.10', downloads: { artifact: { path: 'com/google/code/gson/gson/2.10/gson-2.10.jar', url: 'http://g', sha1: 'b', size: 2 } } },
  // old-style native (2.x LWJGL): classifier chosen from a natives map
  { name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4', natives: { linux: 'natives-linux' }, extract: { exclude: ['META-INF/'] },
    downloads: { classifiers: { 'natives-linux': { path: 'org/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar', url: 'http://n', sha1: 'a', size: 1 } } } },
  // new-style native (3.x LWJGL): a natives-* classifier artifact, gated by rules
  { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }],
    downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar', url: 'http://l', sha1: 'c', size: 3 } } },
  // osx-only regular lib — must be dropped on linux
  { name: 'ca.weblite:java-objc-bridge:1.1', rules: [{ action: 'allow', os: { name: 'osx' } }],
    downloads: { artifact: { path: 'ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar', url: 'http://o' } } },
  // duplicate of gson (different version) — first wins in the classpath
  { name: 'com.google.code.gson:gson:2.11', downloads: { artifact: { path: 'com/google/code/gson/gson/2.11/gson-2.11.jar', url: 'http://g2' } } }
];
const resolved = mojang.resolveLibraries(libs, { platform: 'linux', arch: 'x64' });
ok('gson goes on the classpath', resolved.classpath.some((l) => l.path.includes('gson-2.10.jar')));
ok('osx-only lib is excluded on linux', !resolved.classpath.some((l) => l.name.includes('java-objc-bridge')));
ok('classpath dedupes by group:artifact (first wins)',
  resolved.classpath.filter((l) => l.name && l.name.startsWith('com.google.code.gson:gson')).length === 1);
ok('old-style native is extracted, not on classpath',
  resolved.natives.some((n) => n.path.includes('lwjgl-platform-2.9.4-natives-linux.jar')) &&
  !resolved.classpath.some((l) => l.path.includes('natives-linux')));
ok('new-style natives-* artifact is treated as a native',
  resolved.natives.some((n) => n.path.includes('lwjgl-3.3.1-natives-linux.jar')));

// ---- launch spec assembly ----
const merged = {
  id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
  assetIndex: { id: '5' },
  arguments: {
    jvm: ['-Dnatives=${natives_directory}', '-cp', '${classpath}'],
    game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', '--gameDir', '${game_directory}']
  }
};
const spec = mojang.buildLaunchSpec(merged, {
  clientJar: '/h/client.jar', librariesDir: '/h/lib', nativesDir: '/h/nat', assetsDir: '/h/assets',
  gameDir: '/g', libraries: [{ path: 'a.jar' }, { path: 'b.jar' }]
}, { name: 'Steve', accessToken: 'SECRET', uuid: 'u' }, { platform: 'linux', minRamMb: 1024, maxRamMb: 2048 });

ok('memory args present', spec.args.includes('-Xms1024M') && spec.args.includes('-Xmx2048M'));
ok('classpath is lib jars + client jar, colon-joined on linux',
  spec.classpath === '/h/lib/a.jar:/h/lib/b.jar:/h/client.jar');
ok('${natives_directory} substituted', spec.args.includes('-Dnatives=/h/nat'));
ok('-cp followed by the classpath',
  spec.args[spec.args.indexOf('-cp') + 1] === '/h/lib/a.jar:/h/lib/b.jar:/h/client.jar');
ok('${auth_player_name} substituted', spec.args[spec.args.indexOf('--username') + 1] === 'Steve');
ok('${auth_access_token} substituted', spec.args[spec.args.indexOf('--accessToken') + 1] === 'SECRET');
ok('${game_directory} substituted', spec.args[spec.args.indexOf('--gameDir') + 1] === '/g');
ok('mainClass sits between jvm args and game args',
  spec.args.indexOf('net.minecraft.client.main.Main') < spec.args.indexOf('--username') &&
  spec.args.indexOf('net.minecraft.client.main.Main') > spec.args.indexOf('-cp'));

// ---- legacy (pre-1.13) minecraftArguments path ----
const legacy = mojang.buildLaunchSpec(
  { id: '1.8.9', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name} --version ${version_name}' },
  { clientJar: '/c.jar', librariesDir: '/l', nativesDir: '/n', assetsDir: '/a', gameDir: '/g', libraries: [{ path: 'x.jar' }] },
  { name: 'Alex' }, { platform: 'linux' });
ok('legacy uses -Djava.library.path + -cp', legacy.args.includes('-Djava.library.path=/n') && legacy.args.includes('-cp'));
ok('legacy minecraftArguments substituted', legacy.args[legacy.args.indexOf('--username') + 1] === 'Alex');

// ---- loader profile merge ----
const vanilla = { id: '1.20.1', mainClass: 'MC', libraries: [{ name: 'v:lib:1' }], arguments: { jvm: ['-vjvm'], game: ['-vgame'] } };
const prof = { mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16', url: 'https://maven.fabricmc.net/' }], arguments: { jvm: ['-fjvm'], game: [] } };
const m = mojang.mergeLoaderProfile(vanilla, prof);
ok('loader overrides mainClass', m.mainClass === prof.mainClass);
ok('loader keeps the vanilla version id', m.id === '1.20.1');
ok('loader libraries are prepended', m.libraries[0].name === 'net.fabricmc:fabric-loader:0.16');
ok('arguments are concatenated (vanilla then loader)',
  JSON.stringify(m.arguments.jvm) === JSON.stringify(['-vjvm', '-fjvm']) &&
  JSON.stringify(m.arguments.game) === JSON.stringify(['-vgame']));

// A merged Fabric profile flows through resolveLibraries: the loader lib gets a
// URL derived from its maven base (no downloads.artifact block).
const fabricLib = mojang.resolveLibraries(m.libraries, { platform: 'linux' }).classpath
  .find((l) => l.name === 'net.fabricmc:fabric-loader:0.16');
ok('loader lib URL derived from its maven base',
  fabricLib && fabricLib.url === 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16/fabric-loader-0.16.jar');

// ---- loaders registry ----
ok('fabric & quilt are recognised loaders', loaders.isLoader('fabric') && loaders.isLoader('quilt'));
ok('forge is not a supported loader here', !loaders.isLoader('forge'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
