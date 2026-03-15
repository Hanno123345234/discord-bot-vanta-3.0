const p = require('play-dl');
const u = 'https://www.youtube.com/watch?v=wBcptk5YWQI';
(async () => {
  try {
    console.log('validate=', p.yt_validate(u));
    const info = await p.video_basic_info(u);
    console.log('title=', info?.video_details?.title);
    try {
      const s1 = await p.stream(u, { discordPlayerCompatibility: true });
      console.log('stream discord ok type=', s1?.type);
    } catch (e) {
      console.log('stream discord ERR=', e?.message || e);
    }
    try {
      const s2 = await p.stream(u);
      console.log('stream normal ok type=', s2?.type);
    } catch (e) {
      console.log('stream normal ERR=', e?.message || e);
    }
  } catch (e) {
    console.log('general ERR=', e?.message || e);
  }
  process.exit(0);
})();
