import { writeDigestPdf } from '../src/plugin/digest-pdf.js';
const rec = {
  id: 'smoke-2026-04-15',
  leadStoryPreview: 'smoke test',
  data: {
    title: 'Play-In Night 🏀',
    subtitle: '3 story frames and 13 posts reviewed (1 skipped)',
    date: '2026-04-15T00:00:00Z',
    location: 'Local',
    scheduledTime: '10:00 AM',
    sections: [],
    markdown: "# Play-In Night\n\n## 🏀 Top Story: NBA Play-In Tournament Returns Wednesday\n\nThe NBA Play-In Tournament tips off tonight with back-to-back games on Amazon Prime, with **10.3K fans already engaged** in early conversation.\n\n## 🏎️ @danielricciardo\n\nDaniel Ricciardo's midweek carousel told the story of a driver off the clock, with **247.5K likes** across it. One refrain — *\"Good life.\"* — stood out.\n\n## 🌸 @mskz.k4k\n\nSpring arrived in full bloom along the Kannon-ji River in Inawashiro-machi, Fukushima.\n\n## 📢 @nba (Summer League)\n\nThe NBA Summer League returns to Las Vegas July 9–19, 2026. Tickets on sale **May 11th** at `NBAEvents.com`.\n",
  },
};
const out = await writeDigestPdf(rec as any, { downloadsDir: '/tmp' });
console.log('wrote', out);
