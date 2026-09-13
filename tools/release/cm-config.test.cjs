const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const appRequire = createRequire(path.join(root, 'apps/mobile/package.json'));
const yaml = appRequire('js-yaml');

function config() {
  return yaml.load(fs.readFileSync(path.join(root, 'codemagic.yaml'), 'utf8'));
}

test('defines isolated iOS workflows with the documented toolchain', () => {
  const workflows = config().workflows;
  assert.deepEqual(Object.keys(workflows).sort(), ['android-play', 'ios-archive', 'ios-testflight']);
  for (const name of ['ios-archive', 'ios-testflight']) {
    const workflow = workflows[name];
    assert.equal(workflow.instance_type, 'mac_mini_m2');
    assert.equal(workflow.max_build_duration, 60);
    assert.equal(workflow.integrations.app_store_connect, 'Cialai ASC API Key');
    assert.deepEqual(workflow.environment.groups, ['appstore_credentials']);
    assert.equal(workflow.environment.node, '22.23.2');
    assert.equal(workflow.environment.npm, '10.9.8');
    assert.equal(workflow.environment.xcode, 'latest');
    assert.equal(workflow.environment.cocoapods, 'default');
    assert.equal(workflow.environment.vars.BUNDLE_ID, 'br.com.ordinum.cialai');
    assert.equal(workflow.triggering, undefined);
  }
});

test('builds the iOS binding on the runner before Expo prebuild', () => {
  const workflows = config().workflows;
  for (const name of ['ios-archive', 'ios-testflight']) {
    const workflow = workflows[name];
    const scripts = workflow.scripts.map(step => step.script).join('\n');
    assert.match(scripts, /install-go\.sh 1\.26\.5/);
    assert.match(scripts, /build-tunnel-mobile\.sh ios/);
    assert.match(scripts, /modules\/cialai-tunnel\/ios\/Tunnelcore\.xcframework/);
    assert.ok(scripts.indexOf('build-tunnel-mobile.sh ios') < scripts.indexOf('expo prebuild --platform ios'));
    assert.match(scripts, /npm ci/);
    assert.match(scripts, /npm run typecheck --workspace @cialai\/mobile/);
    assert.match(scripts, /npm run lint --workspace @cialai\/mobile/);
    assert.match(scripts, /npm run test --workspace @cialai\/mobile/);
  }
  const binder = fs.readFileSync(path.join(root, 'tools/build-tunnel-mobile.sh'), 'utf8');
  assert.match(binder, /go tool gomobile bind/);
});

test('uploads internally without requesting review and keeps archive local', () => {
  const workflows = config().workflows;
  const publisher = workflows['ios-testflight'].publishing.app_store_connect;
  assert.equal(publisher.auth, 'integration');
  assert.notEqual(publisher.submit_to_testflight, true);
  assert.notEqual(publisher.submit_to_app_store, true);
  assert.equal(publisher.beta_groups, undefined);
  assert.equal(workflows['ios-archive'].publishing, undefined);
});

test('builds and signs the Android binding before publishing to the internal track', () => {
  const workflow = config().workflows['android-play'];
  assert.equal(workflow.instance_type, 'mac_mini_m2');
  assert.equal(workflow.max_build_duration, 60);
  assert.deepEqual(workflow.environment.groups, ['android_credentials', 'google_play']);
  assert.equal(workflow.environment.node, '22.23.2');
  assert.equal(workflow.environment.npm, '10.9.8');
  assert.equal(workflow.environment.ndk, '28.2.13676358');
  assert.equal(workflow.environment.java, 17);
  assert.equal(workflow.environment.vars.ANDROID_PACKAGE, 'br.com.ordinum.cialai');
  assert.equal(workflow.triggering, undefined);
  const scripts = workflow.scripts.map(step => step.script).join('\n');
  assert.match(scripts, /install-go\.sh 1\.26\.5/);
  assert.match(scripts, /build-tunnel-mobile\.sh android/);
  assert.match(scripts, /modules\/cialai-tunnel\/android\/libs\/tunnelcore\.aar/);
  assert.ok(scripts.indexOf('build-tunnel-mobile.sh android') < scripts.indexOf('expo prebuild --platform android'));
  assert.match(scripts, /CM_KEYSTORE_BASE64/);
  assert.match(scripts, /android\/key\.properties/);
  assert.match(scripts, /gradlew bundleRelease/);
  assert.equal(workflow.publishing.google_play.credentials, '$GCLOUD_SERVICE_ACCOUNT_CREDENTIALS');
  assert.equal(workflow.publishing.google_play.track, 'internal');
});
