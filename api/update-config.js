const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { key, value } = req.body;

        if (!key || value === undefined) {
            return res.status(400).json({ error: 'Missing required fields (key, value)' });
        }

        // Only allow updating known config keys
        const allowedKeys = ['max_concurrent'];
        if (!allowedKeys.includes(key)) {
            return res.status(400).json({ error: 'Unknown config key' });
        }

        const resp = await fetch(`${SUPABASE_URL}/rest/v1/ca_config?key=eq.${encodeURIComponent(key)}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ value: value })
        });

        if (!resp.ok) {
            const err = await resp.text();
            return res.status(500).json({ error: 'Failed to update config', details: err });
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Config update error:', error);
        return res.status(500).json({ error: error.message });
    }
}
