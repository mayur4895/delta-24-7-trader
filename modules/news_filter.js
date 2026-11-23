/**
 * Forex Factory & Economic Calendar News Filter Module
 * 
 * Extracts high-impact economic events (CPI, FOMC, NFP, etc.) from Forex Factory's
 * weekly calendar feed and enforces a pre/post-news trading lockout to protect
 * against unpredictable volatility, slippage, and spread blowouts.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, 'news_cache.json');
const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache
const DEFAULT_PRE_NEWS_BUFFER_MINUTES = 30; // Minutes before news to block trades
const DEFAULT_POST_NEWS_BUFFER_MINUTES = 15; // Minutes after news to block trades

function fetchNewsCalendar() {
    return new Promise((resolve, reject) => {
        // Check cache first
        if (fs.existsSync(CACHE_FILE)) {
            try {
                const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
                if (Date.now() - cacheData.timestamp < CACHE_TTL_MS) {
                    return resolve(cacheData.events);
                }
            } catch (e) {
                // Ignore corrupted cache and fetch fresh
            }
        }

        https.get(CALENDAR_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    fs.writeFileSync(CACHE_FILE, JSON.stringify({
                        timestamp: Date.now(),
                        events: parsed
                    }, null, 2), 'utf-8');
                    resolve(parsed);
                } catch (err) {
                    // If parsing fails or blocked, fallback to empty/cached
                    resolve([]);
                }
            });
        }).on('error', (err) => {
            // If network is offline, return cached or empty safely
            if (fs.existsSync(CACHE_FILE)) {
                try {
                    const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
                    return resolve(cacheData.events || []);
                } catch (_) {}
            }
            resolve([]);
        });
    });
}

/**
 * Evaluates whether current time is within a high-impact news blackout window.
 * @param {number} preBufferMinutes - Minutes before event to block
 * @param {number} postBufferMinutes - Minutes after event to block
 * @param {string[]} currencies - Currencies to watch (default USD)
 */
async function checkNewsLockout(
    preBufferMinutes = DEFAULT_PRE_NEWS_BUFFER_MINUTES,
    postBufferMinutes = DEFAULT_POST_NEWS_BUFFER_MINUTES,
    currencies = ['USD']
) {
    const events = await fetchNewsCalendar();
    const now = Date.now();

    const activeEvents = [];

    for (const ev of events) {
        if (!currencies.includes(ev.country)) continue;
        if (ev.impact !== 'High') continue; // Red folder events only

        const eventTime = new Date(ev.date).getTime();
        const lockoutStart = eventTime - (preBufferMinutes * 60 * 1000);
        const lockoutEnd = eventTime + (postBufferMinutes * 60 * 1000);

        if (now >= lockoutStart && now <= lockoutEnd) {
            activeEvents.push({
                title: ev.title,
                country: ev.country,
                impact: ev.impact,
                event_time_utc: new Date(eventTime).toISOString(),
                lockout_until_utc: new Date(lockoutEnd).toISOString(),
                minutes_remaining: Math.ceil((lockoutEnd - now) / 60000)
            });
        }
    }

    if (activeEvents.length > 0) {
        return {
            is_locked: true,
            status: 'NEWS_LOCKOUT_ACTIVE',
            message: `Trading halted: High-impact economic news window active (${activeEvents.map(e => e.title).join(', ')}).`,
            active_events: activeEvents
        };
    }

    // Find next upcoming high impact news
    const upcoming = events
        .filter(ev => currencies.includes(ev.country) && ev.impact === 'High')
        .map(ev => ({
            title: ev.title,
            country: ev.country,
            event_time_utc: new Date(ev.date).toISOString(),
            time_until_event_minutes: Math.round((new Date(ev.date).getTime() - now) / 60000)
        }))
        .filter(ev => ev.time_until_event_minutes > 0)
        .sort((a, b) => a.time_until_event_minutes - b.time_until_event_minutes)[0] || null;

    return {
        is_locked: false,
        status: 'NEWS_CLEAR',
        message: 'No high-impact economic news in immediate window.',
        next_upcoming_event: upcoming
    };
}

module.exports = {
    fetchNewsCalendar,
    checkNewsLockout
};

if (require.main === module) {
    (async () => {
        console.log('Testing Forex Factory News Filter...');
        const status = await checkNewsLockout();
        console.log(JSON.stringify(status, null, 2));
    })();
}
