const p = require('play-dl');
const u = 'https://www.youtube.com/watch?v=wBcptk5YWQI';
(async () => {
  try {
    const info = await p.video_info(u);
    const formats = (info && info.format) ? info.format : (info?.video_details?.format || []);
    console.log('formats=', Array.isArray(formats) ? formats.length : typeof formats);
    if (Array.isArray(formats)) {
      let shown = 0;
      for (const f of formats) {
        if (!f || !f.url) continue;
        let ok = true;
        try { new URL(String(f.url)); } catch { ok = false; }
        console.log('itag=', f.itag, 'mime=', f.mimeType || f.mime_type, 'audio=', f.audio, 'okUrl=', ok);
        if (++shown >= 15) break;
      }
    }
  } catch (e) {
    console.log('ERR=', e?.message || e);
  }
  process.exit(0);
})();
