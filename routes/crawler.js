const express = require('express');
const router = express.Router();
const { crawl } = require('../scripts/osm_crawler');

/**
 * POST /api/crawler/run
 * Trigger the crawler for a specific city and coordinates
 */
router.post('/run', async (req, res) => {
    const { city, latitude, longitude } = req.body;

    if (!city || !latitude || !longitude) {
        return res.status(400).json({ error: 'Missing city, latitude, or longitude' });
    }

    console.log(`📡 Crawler trigger requested for: ${city} (${latitude}, ${longitude})`);

    try {
        // Run the crawler and wait for completion since we have optimized it to be parallel
        const result = await crawl(city, latitude, longitude);
        console.log(`🏁 Crawl finished for ${city}:`, result);

        res.json({
            message: `Crawl finished for ${city}.`,
            status: 'success',
            result: result
        });
    } catch (error) {
        console.error('Crawler route error:', error);
        res.status(500).json({ error: 'Failed to start crawler' });
    }
});

module.exports = router;
