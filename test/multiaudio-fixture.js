'use strict';
// Five seconds of silent PCM with Japanese/Italian track tags and an Italian
// subtitle. Generated locally; no downloaded video or external encoder needed.
module.exports = function multiaudioFixture() {
  const id = hex => Buffer.from(hex, 'hex');
  const size = n => {
    for (let length = 1; length <= 8; length++) if (BigInt(n) < (1n << BigInt(7 * length)) - 1n) {
      let value = BigInt(n) | (1n << BigInt(7 * length)); const bytes = Buffer.alloc(length);
      for (let i = length - 1; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; } return bytes;
    }
    throw new Error('Fixture too large');
  };
  const element = (hex, content) => { const bytes = Buffer.isBuffer(content) ? content : Buffer.concat(content); return Buffer.concat([id(hex), size(bytes.length), bytes]); };
  const uint = (hex, n) => { let text = n.toString(16); if (text.length % 2) text = '0' + text; return element(hex,id(text)); };
  const text = (hex, value) => element(hex,Buffer.from(value));
  const float = (hex, n) => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(n); return element(hex,bytes); };
  const header = element('1a45dfa3',[uint('4286',1),uint('42f7',1),uint('42f2',4),uint('42f3',8),text('4282','matroska'),uint('4287',4),uint('4285',2)]);
  const info = element('1549a966',[uint('2ad7b1',1000000),float('4489',5000),text('4d80','Anime Player test'),text('5741','Anime Player test')]);
  const audio = (number,language) => element('ae',[uint('d7',number),uint('73c5',number),uint('83',2),uint('88',number === 1 ? 1 : 0),text('86','A_PCM/INT/LIT'),text('22b59c',language),element('e1',[float('b5',8000),uint('9f',1),uint('6264',16)])]);
  const tracks = element('1654ae6b',[audio(1,'jpn'),audio(2,'ita'),element('ae',[uint('d7',3),uint('73c5',3),uint('83',17),text('86','S_TEXT/UTF8'),text('22b59c','ita')])]);
  const block = (track, time, bytes) => { const head = Buffer.alloc(4); head[0] = 0x80 | track; head.writeInt16BE(time,1); head[3] = 0x80; return Buffer.concat([head,bytes]); };
  const blocks = [uint('e7',0),element('a0',[element('a1',block(3,0,Buffer.from('Sottotitolo di prova'))),uint('9b',5000)])];
  for (let ms = 0; ms < 5000; ms += 100) for (const track of [1,2]) blocks.push(element('a3',block(track,ms,Buffer.alloc(1600))));
  return Buffer.concat([header,element('18538067',[info,tracks,element('1f43b675',blocks)])]);
};
