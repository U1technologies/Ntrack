// Sends real requests through the local tracker for DEMO links so the dashboard has data that
// was actually measured. Development only. Usage: node scripts/demo-traffic.mjs [clicksPerLink]

const TRACKER = process.env.TRACKER_URL || 'http://localhost:4100';
const HOST = process.env.DEMO_TRACKING_HOST || 'trk.localhost';
const perLink = Number(process.argv[2] || 20);
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to generate demo traffic in production');

const agents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'curl/8.4.0',
];
const subs = ['newsletter', 'homepage', 'sidebar', 'social', ''];

const { PrismaClient } = await import('@prisma/client');
const client = new PrismaClient();
const links = await client.trackingLink.findMany({ where: { name: { startsWith: 'DEMO ' }, active: true }, select: { slug: true } });
await client.$disconnect();
if (links.length === 0) throw new Error('No DEMO links found. Run: npm run seed -w @ntrack/api -- --demo');

let sent = 0;
for (const { slug } of links) {
  for (let i = 0; i < perLink; i += 1) {
    const ua = agents[Math.floor(Math.random() * agents.length)];
    const sub = subs[Math.floor(Math.random() * subs.length)];
    // Unique X-Forwarded-For per request only matters with TRUST_PROXY=true; otherwise every
    // click shares one IP and repeats are classified as duplicates, which is the correct behaviour.
    await fetch(`${TRACKER}/c/${slug}${sub ? `?sub1=${sub}` : ''}`, { redirect: 'manual', headers: { host: HOST, 'user-agent': `${ua} demo-${i}` } });
    sent += 1;
  }
}
console.log(`Sent ${sent} real clicks through ${TRACKER} for ${links.length} DEMO links.`);
