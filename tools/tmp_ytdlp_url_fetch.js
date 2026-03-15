const https = require('https');
const ytdlp = require('yt-dlp-exec');

(async () => {
  try {
    const out = await ytdlp('https://www.youtube.com/watch?v=wBcptk5YWQI', {
      getUrl: true,
      format: 'bestaudio',
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    });
    const url = String(out).split(/\r?\n/).find(Boolean);
    console.log('got url=', !!url);
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      console.log('status=', res.statusCode, 'ct=', res.headers['content-type']);
      res.destroy();
      process.exit(0);
    });
    req.on('error', (e) => {
      console.log('ERR=', e.message);
      process.exit(0);
    });
    setTimeout(() => {
      console.log('timeout');
      req.destroy();
      process.exit(0);
    }, 15000);
  } catch (e) {
    console.log('ERR2=', e?.message || e);
    process.exit(0);
  }
})();
