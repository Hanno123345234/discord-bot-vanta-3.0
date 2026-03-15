const p = require('play-dl');
const u = 'https://www.youtube.com/watch?v=wBcptk5YWQI';
(async () => {
  try {
    const info = await p.video_info(u);
    console.log('video_info ok');
    const result = await Promise.race([
      p.stream_from_info(info, { discordPlayerCompatibility: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stream_from_info timeout')), 15000))
    ]);
    console.log('stream_from_info ok', !!result, result?.type);
  } catch (e) {
    console.log('ERR=', e?.message || e);
  }
  process.exit(0);
})();
