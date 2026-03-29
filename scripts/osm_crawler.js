const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing Supabase configuration");
    if (require.main === module) process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Category mapping from OSM to SmartPlan
const CATEGORY_MAP = {
    'restaurant': 'restaurant',
    'food_court': 'restaurant',
    'fast_food': 'restaurant',
    'bar': 'bar',
    'pub': 'bar',
    'cafe': 'cafe',
    'museum': 'culture',
    'theatre': 'culture',
    'arts_centre': 'culture',
    'gallery': 'culture',
    'nightclub': 'nightlife',
    'park': 'outdoor',
    'beach': 'outdoor',
    'garden': 'outdoor',
    'stadium': 'sport',
    'swimming_pool': 'sport',
    'sports_centre': 'sport',
    'mall': 'shopping',
    'department_store': 'shopping'
};

/**
 * Fetch data from Overpass API (OSM)
 */
async function fetchFromOSM(city, lat, lon, radius = 2000) {
    console.log(`🔍 Searching OSM for ${city} (lat: ${lat}, lon: ${lon})...`);

    const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"restaurant|cafe|bar|pub|nightclub|museum|theatre"](around:${radius}, ${lat}, ${lon});
      node["leisure"~"park|garden|stadium|swimming_pool"](around:${radius}, ${lat}, ${lon});
      node["tourism"~"museum|gallery|attraction"](around:${radius}, ${lat}, ${lon});
      node["shop"~"mall|department_store"](around:${radius}, ${lat}, ${lon});
    );
    out body;
  `;

    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`OSM API error: ${response.statusText}`);
        const data = await response.json();
        return data.elements || [];
    } catch (error) {
        console.error("❌ Failed to fetch from OSM:", error);
        return [];
    }
}

/**
 * Enrich plan data using Groq AI
 */
async function enrichWithAI(name, osmCategory, city) {
    if (!GROQ_API_KEY) return { description: `Un lieu de type ${osmCategory} à ${city}`, emoji: '📍' };

    try {
        const prompt = `Lieu: "${name}" (${osmCategory}) à ${city}.
Génère une description courte (max 80 caractères) en français et un emoji pertinent.
Format JSON unique : {"description": "...", "emoji": "..."}`;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "mixtral-8x7b-32768",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.7,
                max_tokens: 100,
                response_format: { type: "json_object" }
            }),
        });

        const data = await response.json();
        return JSON.parse(data.choices[0].message.content);
    } catch (error) {
        return { description: `Un lieu à découvrir à ${city}`, emoji: '📍' };
    }
}

/**
 * Main Crawler Logic
 */
async function crawl(city, lat, lon) {
    // Check if we already have plans for this city
    const { count } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('location', city);
    if (count && count > 5) {
        console.log(`ℹ️ City ${city} already has ${count} plans. Skipping crawl.`);
        return { status: 'skipped', count };
    }

    const elements = await fetchFromOSM(city, lat, lon);
    console.log(`✅ Found ${elements.length} elements from OSM.`);

    // Take first 15 for demo to avoid rate limits
    const sample = elements.filter(el => el.tags && el.tags.name).slice(0, 15);

    const enrichPromises = sample.map(async (el) => {
        const name = el.tags.name;
        const osmType = el.tags.amenity || el.tags.leisure || el.tags.tourism || el.tags.shop || 'autre';
        const category = CATEGORY_MAP[osmType] || 'restaurant';

        console.log(`✨ Processing: ${name} (${category})...`);

        const aiData = await enrichWithAI(name, category, city);

        return {
            name: name,
            category: category,
            location: city,
            address: el.tags['addr:full'] || el.tags['addr:street'] || city,
            latitude: el.lat,
            longitude: el.lon,
            description: aiData.description,
            emoji: aiData.emoji,
            rating: 4.0 + Math.random(),
            reviews_count: Math.floor(Math.random() * 50) + 1,
            score: Math.floor(Math.random() * 50) + 50,
            is_good_plan: true,
            ai_recommended: Math.random() > 0.5,
            tags: Object.keys(el.tags).filter(t => !['name', 'amenity', 'leisure', 'tourism', 'shop'].includes(t)).slice(0, 3)
        };
    });

    const plansToInsert = await Promise.all(enrichPromises);

    if (plansToInsert.length > 0) {
        console.log(`🚀 Inserting ${plansToInsert.length} enriched plans into Supabase...`);
        const { error } = await supabase.from('plans').insert(plansToInsert);
        if (error) {
            console.error("❌ Insertion error:", error.message);
            throw error;
        } else {
            console.log("🎉 Successfully crawled and enriched data!");
            return { status: 'success', count: plansToInsert.length };
        }
    }
    return { status: 'no_data', count: 0 };
}

module.exports = { crawl };

if (require.main === module) {
    crawl('Paris', 48.8566, 2.3522);
}
