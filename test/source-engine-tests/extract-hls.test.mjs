import test from 'node:test';
import assert from 'node:assert/strict';
import { windowData, vixSources, inertiaProps, csrfMeta } from '../../src/source-engine/extract.mjs';
import { parseHls, selectVariant, attributes } from '../../src/source-engine/hls.mjs';

const base = 'https://cdn.example/path/master?token=secret';
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja",URI="../audio/ja.m3u8"\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"\n720.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"\n1080.m3u8\n';
test('AST reads only explicit data, preserves semicolons and apostrophes in URLs', () => {
  const html = '<script>window.downloadUrl = "https://cdn.example/a;b?x=it\'s";</script>';
  assert.equal(windowData(html).downloadUrl, "https://cdn.example/a;b?x=it's");
});
test('computed expressions, functions and prototype pollution are rejected', () => {
  for (const expression of ['evil()', '(()=>"https://cdn.example")()', '{"__proto__":{x:1}}', '{[evil()]:1}']) {
    assert.throws(() => windowData('<script>window.masterPlaylist=' + expression + ';</script>'), /unsafe_script/);
  }
});
test('unrelated executable scripts are never evaluated', () => {
  assert.deepEqual(Object.keys(windowData('<script>throw Error("executed")</script>')), []);
});
test('playlist params are encoded once, existing query retained and FHD only when true', () => {
  const html = '<script>window.masterPlaylist={url:"/playlist/7?b:1",params:{token:"a+b&c",expires:9999999999,},};window.canPlayFHD=true;</script>';
  const s = vixSources(html, 'https://vix.example/embed/7');
  const u = new URL(s[0].url);
  assert.equal(u.searchParams.get('token'), 'a+b&c'); assert.equal(u.searchParams.get('b'), '1');
  assert.equal(u.searchParams.get('h'), '1');
});
test('expired signed URL never appears as a working source', () => {
  assert.throws(() => vixSources('<script>window.masterPlaylist={url:"/x",params:{expires:1}};</script>',
    'https://vix.example/embed/1'), { code: 'signed_url_expired' });
});
test('HTML entities are decoded once for Inertia JSON', () => {
  const h = '<div id="app" data-page="{&quot;props&quot;:{&quot;title&quot;:&quot;A &amp;amp; B&quot;}}"></div>';
  assert.equal(inertiaProps(h).title, 'A &amp; B');
  assert.equal(csrfMeta('<meta content="token" name="csrf-token">'), 'token');
});
test('codec commas are not confused with attribute delimiters', () => {
  assert.equal(attributes('CODECS="avc1,mp4a",BANDWIDTH=1').CODECS, 'avc1,mp4a');
});
test('highest reported resolution wins over the bitrate of a lower resolution', () => {
  const m = parseHls(master, base), selected = selectVariant(m, { audio: 'jpn' });
  assert.equal(selected.variant.height, 1080);
  assert.equal(selected.audio[0].uri, 'https://cdn.example/audio/ja.m3u8');
  assert.equal(selectVariant(m, { maxHeight: 720 }).variant.height, 720);
});
test('strict requested tracks cannot silently become another language', () => {
  const m = parseHls(master, base);
  assert.throws(() => selectVariant(m, { audio: 'it' }), { code: 'requested_tracks_unproven' });
  assert.throws(() => selectVariant(m, { subtitles: 'it' }), { code: 'requested_tracks_unproven' });
});
test('muxed audio without HLS language metadata remains pending a real container probe', () => {
  const m = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=320x180\nv.m3u8', base);
  const r = selectVariant(m, { audio: 'ja' });
  assert.equal(r.audioPendingProbe, true); assert.deepEqual(r.audio, []);
});
test('AES key rotation and METHOD NONE remain per segment', () => {
  const m = parseHls('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI="k1"\n#EXTINF:2,\na.ts\n'
    + '#EXT-X-KEY:METHOD=AES-128,URI="k2",IV=0xabc\n#EXTINF:3,\nb.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nc.ts\n#EXT-X-ENDLIST', base);
  assert.equal(m.segments[0].sequence, 10); assert.equal(m.segments[1].key.iv, '0xabc');
  assert.equal(m.segments[2].key, null); assert.equal(m.duration, 6);
});
test('fMP4 init maps and byteranges preserve offsets', () => {
  const m = parseHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"\n'
    + '#EXTINF:2,\n#EXT-X-BYTERANGE:20@100\na.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:30\na.mp4\n#EXT-X-ENDLIST', base);
  assert.equal(m.segments[1].range.offset, 120); assert.equal(m.segments[1].map.range.length, 100);
});
for (const [label, body, code] of [
  ['html', '<html>Blocked</html>', 'not_hls'],
  ['DRM', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:1,\na.ts', 'drm_or_encryption_unsupported'],
  ['empty', '#EXTM3U', 'hls_empty'],
  ['missing URI', '#EXTM3U\n#EXTINF:1,', 'hls_incomplete'],
  ['gap', '#EXTM3U\n#EXT-X-GAP\n#EXTINF:1,\na.ts', 'hls_gap'],
  ['unknown offset', '#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:20\na.ts', 'invalid_byte_range'],
  ['duplicate attribute', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,BANDWIDTH=2\na.m3u8', 'duplicate_hls_attribute'],
]) test('malformed/protected HLS: ' + label, () => assert.throws(() => parseHls(body, base), { code }));
