const ytdl = require('@distube/ytdl-core');
const u = 'https://www.youtube.com/watch?v=wBcptk5YWQI';
(async () => {
  try {
    const info = await ytdl.getInfo(u);
    console.log('title=', info?.videoDetails?.title);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    console.log('format url exists=', !!format?.url);
  } catch (e) {
    console.log('ERR=', e?.message || e);
  }
  process.exit(0);
})();
