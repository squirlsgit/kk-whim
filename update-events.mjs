// update-events.mjs — refreshes events.json daily. Run by GitHub Actions (see update-events.yml).
// Node 18+, no dependencies. Usage: node update-events.mjs
//
// v2 changes:
//   • Extracts each event's OFFICIAL website (artist/venue homepage) when Ticketmaster
//     provides one — `url` is the official site, `tix` is the ticket link.
//   • Covers ~55 major US + Canadian metros, each with a 130-mile radius (~3 hr drive),
//     so neighborhoods and nearby towns around every metro are included.
//   • Detects free events via price ranges, maps more categories, rate-limits politely.
//
// Every run: load events.json → drop ended events → fetch new ones per metro →
// de-duplicate → write back. Curated/hand-added events (no `src` field) are kept
// until they end; only expired events are ever removed.
//
// Requires a free Ticketmaster Discovery API key as env TM_API_KEY
// (https://developer.ticketmaster.com — the Consumer Key; no OAuth needed).

import { readFileSync, writeFileSync } from "node:fs";

const FILE = "events.json";
const today = new Date().toISOString().slice(0, 10);
const RADIUS_MILES = 130;          // ≈ 3-hour drive
const PER_METRO = 30;              // events fetched per metro per day
const DELAY_MS = 300;              // stay well under TM's 5 req/sec limit

// Major metros — US + Canada. Matches (a superset of) the app's m:1 gazetteer cities.
const METROS = [
  ["Seattle",47.6062,-122.3321],["Portland OR",45.5152,-122.6784],["San Francisco",37.7749,-122.4194],
  ["San Jose",37.3382,-121.8863],["Sacramento",38.5816,-121.4944],["Los Angeles",34.0522,-118.2437],
  ["San Diego",32.7157,-117.1611],["Las Vegas",36.1699,-115.1398],["Reno",39.5296,-119.8138],
  ["Phoenix",33.4484,-112.0740],["Tucson",32.2226,-110.9747],["Salt Lake City",40.7608,-111.8910],
  ["Boise",43.6150,-116.2023],["Denver",39.7392,-104.9903],["Albuquerque",35.0844,-106.6504],
  ["El Paso",31.7619,-106.4850],["Austin",30.2672,-97.7431],["San Antonio",29.4241,-98.4936],
  ["Dallas",32.7767,-96.7970],["Houston",29.7604,-95.3698],["Oklahoma City",35.4676,-97.5164],
  ["Tulsa",36.1540,-95.9928],["Kansas City",39.0997,-94.5786],["St. Louis",38.6270,-90.1994],
  ["Omaha",41.2565,-95.9345],["Des Moines",41.5868,-93.6250],["Minneapolis",44.9778,-93.2650],
  ["Milwaukee",43.0389,-87.9065],["Chicago",41.8781,-87.6298],["Indianapolis",39.7684,-86.1581],
  ["Columbus",39.9612,-82.9988],["Cincinnati",39.1031,-84.5120],["Cleveland",41.4993,-81.6944],
  ["Detroit",42.3314,-83.0458],["Pittsburgh",40.4406,-79.9959],["Buffalo",42.8864,-78.8784],
  ["Boston",42.3601,-71.0589],["Providence",41.8240,-71.4128],["Hartford",41.7658,-72.6734],
  ["New York City",40.7128,-74.0060],["Philadelphia",39.9526,-75.1652],["Baltimore",39.2904,-76.6122],
  ["Washington DC",38.9072,-77.0369],["Richmond",37.5407,-77.4360],["Raleigh",35.7796,-78.6382],
  ["Charlotte",35.2271,-80.8431],["Atlanta",33.7490,-84.3880],["Nashville",36.1627,-86.7816],
  ["Memphis",35.1495,-90.0490],["Louisville",38.2527,-85.7585],["Birmingham",33.5186,-86.8104],
  ["New Orleans",29.9511,-90.0715],["Jacksonville",30.3322,-81.6557],["Orlando",28.5383,-81.3792],
  ["Tampa",27.9506,-82.4572],["Miami",25.7617,-80.1918],["Honolulu",21.3069,-157.8583],
  ["Anchorage",61.2181,-149.9003],
  // Canada
  ["Vancouver BC",49.2827,-123.1207],["Victoria BC",48.4284,-123.3656],["Calgary",51.0447,-114.0719],
  ["Edmonton",53.5461,-113.4938],["Saskatoon",52.1332,-106.6700],["Regina",50.4452,-104.6189],
  ["Winnipeg",49.8951,-97.1384],["Toronto",43.6532,-79.3832],["Hamilton ON",43.2557,-79.8711],
  ["London ON",42.9849,-81.2453],["Ottawa",45.4215,-75.6972],["Montreal",45.5019,-73.5674],
  ["Quebec City",46.8139,-71.2080],["Halifax",44.6488,-63.5752],
];

const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TM_CAT = {
  Music: "music", "Arts & Theatre": "theater", Sports: "community",
  Film: "film", Family: "community", Miscellaneous: "community",
};

// Best-available OFFICIAL website for an event:
// artist/attraction homepage → venue homepage → null (fall back to ticket link).
function officialSite(ev) {
  const links = ev._embedded?.attractions?.[0]?.externalLinks;
  const home = links?.homepage?.[0]?.url;
  if (home && /^https?:\/\//.test(home)) return home;
  const venueUrl = ev._embedded?.venues?.[0]?.url;
  if (venueUrl && /^https?:\/\//.test(venueUrl) && !/ticketmaster/i.test(venueUrl)) return venueUrl;
  return null;
}

async function fromTicketmaster([name, lat, lng]) {
  const key = process.env.TM_API_KEY;
  if (!key) return [];
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${key}` +
    `&latlong=${lat},${lng}&radius=${RADIUS_MILES}&unit=miles&size=${PER_METRO}` +
    `&sort=date,asc&startDateTime=${today}T00:00:00Z`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`TM ${name}: HTTP ${res.status}`); return []; }
  const data = await res.json();
  return (data._embedded?.events ?? []).map(ev => {
    const venue = ev._embedded?.venues?.[0];
    const start = ev.dates?.start?.localDate;
    if (!venue?.location || !start) return null;
    const official = officialSite(ev);
    const tix = ev.url && /^https?:\/\//.test(ev.url) ? ev.url : null;
    const price = ev.priceRanges?.[0];
    return {
      t: ev.name,
      s: start,
      e: ev.dates?.end?.localDate || start,
      v: `${venue.name}${venue.city?.name ? ", " + venue.city.name : ""}`,
      lat: +venue.location.latitude,
      lng: +venue.location.longitude,
      cat: TM_CAT[ev.classifications?.[0]?.segment?.name] ?? "community",
      url: official || tix || "#",          // official website preferred
      tix: official && tix ? tix : undefined, // ticket link shown separately when both exist
      free: price ? price.min === 0 : false,
      ver: true,
      src: "ticketmaster",
      sum: (ev.info || ev.pleaseNote || `Live at ${venue.name}.`).slice(0, 180),
    };
  }).filter(Boolean);
}

// TODO: more sources return the same shape — city open-data permits, venue iCal
// feeds, schema.org extraction from official sites. Add them to SOURCES.
const SOURCES = [fromTicketmaster];

async function main() {
  let events = [];
  try { events = JSON.parse(readFileSync(FILE, "utf8")); } catch { console.log("No existing events.json — starting fresh."); }

  const before = events.length;
  events = events.filter(ev => ev.e >= today);
  console.log(`Expired ${before - events.length} ended events.`);

  const seen = new Set(events.map(ev => slug(ev.t) + "|" + ev.s));
  let added = 0;
  for (const metro of METROS) {
    for (const source of SOURCES) {
      try {
        for (const ev of await source(metro)) {
          const key = slug(ev.t) + "|" + ev.s;
          if (seen.has(key)) continue;
          seen.add(key);
          ev._id = slug(ev.t);
          events.push(ev);
          added++;
        }
      } catch (err) { console.error(`${source.name} ${metro[0]} failed:`, err.message); }
      await sleep(DELAY_MS);
    }
  }
  console.log(`Added ${added} new events across ${METROS.length} metros. Total: ${events.length}.`);

  events.sort((a, b) => a.s.localeCompare(b.s));
  writeFileSync(FILE, JSON.stringify(events, null, 1));
}

main();
