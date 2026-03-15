const p = require('play-dl');
const u = 'https://www.youtube.com/watch?v=wBcptk5YWQI';
(async () => {
  try {
    const info = await p.video_info(u);
    const arr = Array.isArray(info?.format) ? info.format : [];
    console.log('formats', arr.length);
    const sample = arr.find(x => x && (x.audio === true || x.mimeType?.includes('audio') || x.mime_type?.includes('audio')) && x.url) || arr.find(x=>x&&x.url);
    if (!sample) { console.log('no sample'); process.exit(0); }
    console.log('keys', Object.keys(sample));
    console.log('mime', sample.mimeType || sample.mime_type);
    console.log('audio', sample.audio, 'video', sample.video);
    console.log('url head', String(sample.url).slice(0,120));
    try { const uu = new URL(String(sample.url)); console.log('url parse ok host=', uu.host); } catch(e){ console.log('url parse err', e.message); }
  } catch (e) {
    console.log('ERR=', e?.message || e);
  }
  process.exit(0);
})();
