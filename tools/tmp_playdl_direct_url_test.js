const p = require('play-dl');
const https = require('https');
const u = 'https://www.youtube.com/watch?v=wBcptk5YWQI';
(async () => {
  try {
    const info = await p.video_info(u);
    const arr = Array.isArray(info?.format) ? info.format : [];
    const fmt = arr.find(f => f && typeof f.mimeType === 'string' && f.mimeType.includes('audio') && f.url) || arr.find(f => f && f.url);
    if (!fmt) throw new Error('no format url');
    const direct = String(fmt.url);
    console.log('using mime=', fmt.mimeType);
    const req = https.get(direct, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      console.log('status=', res.statusCode, 'content-type=', res.headers['content-type']);
      res.destroy();
      process.exit(0);
    });
    req.on('error', (e) => { console.log('REQ ERR=', e.message); process.exit(0); });
    setTimeout(() => { console.log('timeout'); req.destroy(); process.exit(0); }, 10000);
  } catch (e) {
    console.log('ERR=', e?.message || e);
    process.exit(0);
  }
})();
