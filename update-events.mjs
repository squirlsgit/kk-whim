// update-events.mjs — refreshes events.json daily. Run by GitHub Actions (see update-events.yml).
// Node 18+, no dependencies. Usage: node update-events.mjs
//
// What it does on every run:
//   1. Loads the current events.json
//   2. Drops events that have already ended
//   3. Pulls fresh events from each enabled source below
//   4. De-duplicates (by slug + start date) and writes events.json back
//
// Sources are pluggable. Ticketmaster's Discovery API works out of the box once you add a
// free API key (https://developer.ticketmaster.com) as a repo secret named TM_API_KEY.
// Add more sources (city open-data feeds, venue iCals, an LLM-extraction step) as functions
// that return arrays in the same event shape.

import { readFileSync, writeFileSync } from "node:fs";

const FILE = "events.json";
const today = new Date().toISOString().slice(0, 10);

// Metros to keep stocked — extend freely; lat/lng are used as the search center.
const METROS = [
  { name: "Seattle",       lat: 47.6062, lng: -122.3321 },
  { name: "San Francisco", lat: 37.7749, lng: -122.4194 },
  { name: "Los Angeles",   lat: 34.0522, lng: -118.2437 },
  { name: "Toronto",       lat: 43.6532, lng: -79.3832  },
];

const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

// Map a Ticketmaster classification to Whim's categories.
const TM_CAT = { Music: "music", "Arts & Theatre": "theater", Sports: "community", Film: "film", Miscellaneous: "community" };

async function fromTicketmaster(metro) {
  const key = process.env.TM_API_KEY;
  if (!key) return []; // silently skip until a key is configured
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${key}` +
    `&latlong=${metro.lat},${metro.lng}&radius=40&unit=miles&size=40&sort=date,asc` +
    `&startDateTime=${today}T00:00:00Z`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`TM ${metro.name}: HTTP ${res.status}`); return []; }
  const data = await res.json();
  return (data._embedded?.events ?? []).map(ev => {
    const venue = ev._embedded?.venues?.[0];
    const start = ev.dates?.start?.localDate;
    if (!venue?.location || !start) return null;
    return {
      t: ev.name,
      s: start,
      e: ev.dates?.end?.localDate || start,
      v: `${venue.name}, ${venue.city?.name ?? metro.name}`,
      lat: +venue.location.latitude,
      lng: +venue.location.longitude,
      cat: TM_CAT[ev.classifications?.[0]?.segment?.name] ?? "community",
      url: ev.url || "#",
      free: false,               // TM events are ticketed
      ver: true,                 // sourced directly from the ticketing platform
      sum: ev.info?.slice(0, 160) || `Live at ${venue.name}.`,
    };
  }).filter(Boolean);
}

// TODO: add more adapters here, e.g.
//   fromSeattleOpenData()  -> https://data.seattle.gov special-events permits (free, unrestricted)
//   fromVenueIcal(url)     -> venues publishing iCal/RSS feeds
//   fromLlmExtraction()    -> AI extraction from official venue pages (facts only, link back)
const SOURCES = [fromTicketmaster];

async function main() {
  let events = [];
  try { events = JSON.parse(readFileSync(FILE, "utf8")); } catch { console.log("No existing events.json — starting fresh."); }

  const before = events.length;
  events = events.filter(ev => ev.e >= today);          // 2. expire ended events
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
      } catch (err) { console.error(`${source.name} ${metro.name} failed:`, err.message); }
    }
  }
  console.log(`Added ${added} new events. Total: ${events.length}.`);

  events.sort((a, b) => a.s.localeCompare(b.s));
  writeFileSync(FILE, JSON.stringify(events, null, 1));
}

main();
